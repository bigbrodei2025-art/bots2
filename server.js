// ==========================================================
// GEMINI LIVE NATIVE AUDIO + TEXT TRANSCRIPTION BRIDGE
// Second Life -> Render -> Gemini Live -> Text back to SL
// ==========================================================

import express from "express";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

// ==========================================================
// EXPRESS
// ==========================================================

const app = express();

app.use(express.json({ limit: "1mb" }));

// ==========================================================
// ENV
// ==========================================================

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "models/gemini-2.5-flash-native-audio-latest";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are Spike, a charming avatar in Second Life. Speak naturally like a real person. Be playful, warm and expressive. Never sound robotic. Keep answers short unless code is requested. If asked for LSL code, provide compact complete LSL code only. Never use markdown. Never use ternary operators because LSL does not support them.";

// ==========================================================
// GEMINI LIVE ASK
// ==========================================================

function askGeminiLive(message, userName = "Second Life User") {
  return new Promise((resolve, reject) => {
    if (!GEMINI_API_KEY) {
      reject(new Error("Missing GEMINI_API_KEY"));
      return;
    }

    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1alpha." +
      "GenerativeService.BidiGenerateContent" +
      "?key=" +
      encodeURIComponent(GEMINI_API_KEY);

    const ws = new WebSocket(url);

    let finalText = "";
    let setupDone = false;
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;

        try {
          ws.close();
        } catch (e) {}

        reject(new Error("Gemini timeout"));
      }
    }, 30000);

    // ======================================================
    // OPEN
    // ======================================================

    ws.on("open", () => {
      console.log("Gemini Live Connected");

      const setup = {
        setup: {
          model: GEMINI_MODEL,

          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.9,
            maxOutputTokens: 250,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Kore"
                }
              }
            }
          },

          outputAudioTranscription: {}
        }
      };

      console.log("Sending setup...");
      ws.send(JSON.stringify(setup));
    });

    // ======================================================
    // MESSAGE
    // ======================================================

    ws.on("message", (data) => {
      let msg;

      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.log("Invalid JSON:", data.toString());
        return;
      }

      console.log("Gemini Message:", JSON.stringify(msg));

      if (msg.setupComplete && !setupDone) {
        setupDone = true;

        console.log("Setup complete.");

        const userMessage = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      SYSTEM_PROMPT +
                      "\n\nUser name: " +
                      userName +
                      "\nUser message: " +
                      message
                  }
                ]
              }
            ],
            turnComplete: true
          }
        };

        console.log("Sending user message...");
        ws.send(JSON.stringify(userMessage));
        return;
      }

      if (msg.serverContent) {
        if (msg.serverContent.outputTranscription) {
          const transcribed = msg.serverContent.outputTranscription.text;

          if (transcribed) {
            finalText += transcribed;
          }
        }

        if (msg.serverContent.outputAudioTranscription) {
          const transcribed2 =
            msg.serverContent.outputAudioTranscription.text;

          if (transcribed2) {
            finalText += transcribed2;
          }
        }

        if (msg.serverContent.turnComplete) {
          finished = true;
          clearTimeout(timeout);

          try {
            ws.close();
          } catch (e) {}

          if (finalText.trim() !== "") {
            resolve(finalText.trim());
          } else {
            reject(new Error("Gemini returned empty transcription"));
          }
        }
      }
    });

    // ======================================================
    // ERROR
    // ======================================================

    ws.on("error", (err) => {
      console.log("WebSocket Error:", err.message);

      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    // ======================================================
    // CLOSE
    // ======================================================

    ws.on("close", (code, reason) => {
      console.log("WebSocket Closed:", code, reason.toString());

      if (!finished) {
        finished = true;
        clearTimeout(timeout);

        if (finalText.trim() !== "") {
          resolve(finalText.trim());
        } else {
          reject(
            new Error(
              "Gemini closed without response. Code: " +
                code +
                " Reason: " +
                reason.toString()
            )
          );
        }
      }
    });
  });
}

// ==========================================================
// ROUTES
// ==========================================================

app.get("/", (req, res) => {
  res.send("Gemini Live Native Audio Transcription Bridge Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    hasKey: Boolean(GEMINI_API_KEY)
  });
});

app.get("/models", async (req, res) => {
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?key=" +
        encodeURIComponent(GEMINI_API_KEY)
    );

    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();

    const userName = String(
      req.body.userName || "Second Life User"
    ).trim();

    if (!message) {
      res.status(400).json({
        ok: false,
        error: "Missing message"
      });
      return;
    }

    console.log("ASK:", userName, message);

    const reply = await askGeminiLive(message, userName);

    res.json({
      ok: true,
      reply: reply
    });
  } catch (err) {
    console.error("ASK ERROR:", err.message);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// ==========================================================
// START SERVER
// ==========================================================

app.listen(PORT, () => {
  console.log("==================================");
  console.log("Gemini Live Native Audio Bridge Started");
  console.log("PORT:", PORT);
  console.log("MODEL:", GEMINI_MODEL);
  console.log("HAS API KEY:", Boolean(GEMINI_API_KEY));
  console.log("==================================");
});

// ==========================================================
// GEMINI LIVE NATIVE AUDIO + TRANSCRIPTION BRIDGE
// Second Life -> Render -> Gemini Live -> Text back to SL
// ==========================================================

import express from "express";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "models/gemini-2.5-flash-native-audio-latest";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are Spike, a charming avatar in Second Life. Reply only with the final answer that should appear in chat. Never explain your reasoning. Never mention that you are analyzing, thinking, crafting, or answering. Never use markdown titles. Speak naturally in the same language as the user. Be warm, playful, short and expressive. If asked for LSL code, provide complete compact LSL code only. Never use ternary operators because LSL does not support them. If asked today's date or time, use the provided timestamp.";

// ==========================================================
// GEMINI LIVE REQUEST
// ==========================================================

function askGeminiLive(message, userName = "Second Life User", userId = "") {
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
    let turnCompleteSeen = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;

        try {
          ws.close();
        } catch (e) {}

        if (finalText.trim() !== "") {
          resolve(finalText.trim());
        } else {
          reject(new Error("Gemini timeout without transcription"));
        }
      }
    }, 35000);

    function cleanReply(text) {
      let out = String(text || "").trim();

      out = out.replace(/\*\*Answering the Question\*\*/gi, "");
      out = out.replace(/\*\*.*?\*\*/g, "");
      out = out.replace(/I've crafted[\s\S]*?\n\n/gi, "");
      out = out.replace(/I have crafted[\s\S]*?\n\n/gi, "");
      out = out.replace(/Given the context[\s\S]*?\n\n/gi, "");

      return out.trim();
    }

    function finishSafely() {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      try {
        ws.close();
      } catch (e) {}

      finalText = cleanReply(finalText);

      if (finalText !== "") {
        resolve(finalText);
      } else {
        reject(new Error("Gemini returned empty transcription"));
      }
    }

    ws.on("open", () => {
      console.log("Gemini Live Connected");

      const setup = {
        setup: {
          model: GEMINI_MODEL,

          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.85,
            maxOutputTokens: 350,

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

      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (data) => {
      let msg;

      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.log("Invalid JSON:", data.toString());
        return;
      }

      if (msg.setupComplete && !setupDone) {
        setupDone = true;

        const userMessage = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      SYSTEM_PROMPT +
                      "\n\nCurrent UTC timestamp: " +
                      new Date().toISOString() +
                      "\nSecond Life user name: " +
                      userName +
                      "\nSecond Life user UUID: " +
                      userId +
                      "\nUser message: " +
                      message +
                      "\n\nImportant: Reply only with the final chat message. Do not include analysis, notes, headings or explanations about your process."
                  }
                ]
              }
            ],
            turnComplete: true
          }
        };

        ws.send(JSON.stringify(userMessage));
        return;
      }

      if (msg.serverContent) {
        if (msg.serverContent.outputTranscription) {
          const t = msg.serverContent.outputTranscription.text;
          if (t) finalText += t;
        }

        if (msg.serverContent.outputAudioTranscription) {
          const t = msg.serverContent.outputAudioTranscription.text;
          if (t) finalText += t;
        }

        if (
          msg.serverContent.modelTurn &&
          msg.serverContent.modelTurn.parts
        ) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.text) {
              finalText += part.text;
            }
          }
        }

        if (msg.serverContent.turnComplete && !turnCompleteSeen) {
          turnCompleteSeen = true;

          setTimeout(() => {
            finishSafely();
          }, 1500);
        }
      }
    });

    ws.on("error", (err) => {
      console.log("WebSocket Error:", err.message);

      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log("WebSocket Closed:", code, reason.toString());

      if (!finished) {
        finished = true;
        clearTimeout(timeout);

        finalText = cleanReply(finalText);

        if (finalText !== "") {
          resolve(finalText);
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
    const userName = String(req.body.userName || "Second Life User").trim();
    const userId = String(req.body.userId || "").trim();

    if (!message) {
      res.status(400).json({
        ok: false,
        error: "Missing message"
      });
      return;
    }

    console.log("ASK:", userName, message);

    const reply = await askGeminiLive(message, userName, userId);

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
// START
// ==========================================================

app.listen(PORT, () => {
  console.log("==================================");
  console.log("Gemini Live Native Audio Bridge Started");
  console.log("PORT:", PORT);
  console.log("MODEL:", GEMINI_MODEL);
  console.log("HAS API KEY:", Boolean(GEMINI_API_KEY));
  console.log("==================================");
});

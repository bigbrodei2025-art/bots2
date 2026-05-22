// ==========================================================
// GEMINI LIVE TEXT BRIDGE - RENDER
// Second Life -> Render -> Gemini Live
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
  process.env.GEMINI_MODEL || "models/gemini-2.0-flash-live-001";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are Spike, a charming avatar in Second Life. Speak naturally, warmly and shortly. Never sound robotic. If asked for LSL code, provide compact complete LSL code only. Never use markdown. Never use ternary operators because LSL does not support them.";

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

    ws.on("open", () => {
      console.log("Gemini Live Connected");

      const setup = {
        setup: {
          model: GEMINI_MODEL,

          generationConfig: {
            responseModalities: "TEXT",
            temperature: 0.9,
            maxOutputTokens: 250
          },

          systemInstruction: {
            parts: [
              {
                text: SYSTEM_PROMPT
              }
            ]
          }
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

      console.log("Gemini Message:", JSON.stringify(msg));

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
                      "User name: " +
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

        ws.send(JSON.stringify(userMessage));
        return;
      }

      if (msg.serverContent) {
        if (
          msg.serverContent.modelTurn &&
          msg.serverContent.modelTurn.parts
        ) {
          const parts = msg.serverContent.modelTurn.parts;

          for (const part of parts) {
            if (part.text) {
              finalText += part.text;
            }
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
            reject(new Error("Gemini returned empty response"));
          }
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

app.get("/", (req, res) => {
  res.send("Gemini Live Bridge Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    hasKey: Boolean(GEMINI_API_KEY)
  });
});

app.post("/ask", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const userName = String(req.body.userName || "Second Life User").trim();

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

app.listen(PORT, () => {
  console.log("==================================");
  console.log("Gemini Live Bridge Started");
  console.log("PORT:", PORT);
  console.log("MODEL:", GEMINI_MODEL);
  console.log("HAS API KEY:", Boolean(GEMINI_API_KEY));
  console.log("==================================");
});

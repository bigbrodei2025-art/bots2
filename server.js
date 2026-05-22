// ==========================================================
// GEMINI LIVE TEXT BRIDGE
// Second Life -> Render -> Gemini Live -> Second Life
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
  process.env.GEMINI_MODEL || "gemini-live-2.5-flash-preview";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are Spike, a charming avatar in Second Life. Speak naturally, warmly and shortly. Never sound robotic. If asked for LSL code, give compact complete LSL code only. Never use markdown. Never use ternary operators because LSL does not support them.";

// ==========================================================
// ASK GEMINI LIVE
// ==========================================================

function askGeminiLive(message, userName = "Second Life User") {
  return new Promise((resolve, reject) => {
    if (!GEMINI_API_KEY) {
      reject(new Error("Missing GEMINI_API_KEY"));
      return;
    }

    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY);

    const ws = new WebSocket(url);

    let finalText = "";
    let setupComplete = false;
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;

        try {
          ws.close();
        } catch (e) {}

        reject(new Error("Gemini Live timeout"));
      }
    }, 30000);

    // ------------------------------------------------------
    // OPEN
    // ------------------------------------------------------

    ws.on("open", () => {
      console.log("Gemini Live WebSocket opened.");

      const setupMessage = {
        setup: {
          model: "models/" + GEMINI_MODEL,

          generationConfig: {
            responseModalities: ["TEXT"],
            temperature: 0.9,
            maxOutputTokens: 500
          },

          systemInstruction: {
            role: "user",
            parts: [
              {
                text: SYSTEM_PROMPT
              }
            ]
          }
        }
      };

      ws.send(JSON.stringify(setupMessage));
    });

    // ------------------------------------------------------
    // MESSAGE
    // ------------------------------------------------------

    ws.on("message", (data) => {
      let msg;

      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.log("Invalid JSON from Gemini:", data.toString());
        return;
      }

      console.log("Gemini message:", JSON.stringify(msg));

      if (msg.setupComplete && !setupComplete) {
        setupComplete = true;

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
            reject(new Error("Gemini Live returned empty text"));
          }
        }
      }
    });

    // ------------------------------------------------------
    // ERROR
    // ------------------------------------------------------

    ws.on("error", (err) => {
      console.log("Gemini Live WebSocket error:", err.message);

      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    // ------------------------------------------------------
    // CLOSE
    // ------------------------------------------------------

    ws.on("close", (code, reason) => {
      console.log(
        "Gemini Live WebSocket closed:",
        code,
        reason ? reason.toString() : ""
      );

      if (!finished) {
        finished = true;
        clearTimeout(timeout);

        if (finalText.trim() !== "") {
          resolve(finalText.trim());
        } else {
          reject(
            new Error(
              "Gemini Live closed without response. Code: " +
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
  res.send("Gemini Live Text Bridge Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Gemini Live Text Bridge",
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
  console.log("Gemini Live Text Bridge running on port " + PORT);
  console.log("Model:", GEMINI_MODEL);
  console.log("Has API Key:", Boolean(GEMINI_API_KEY));
});

import express from "express";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-live-preview";

const MAX_OUTPUT_TOKENS =
  Number(process.env.MAX_OUTPUT_TOKENS || 350);

const TEMPERATURE =
  Number(process.env.TEMPERATURE || 0.9);

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are Spike, a friendly avatar in Second Life. Speak naturally and shortly.";

function cleanText(text) {
  if (!text) return "";
  return String(text)
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();
}

function askGeminiLive(message, userName) {
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
    let finished = false;
    let setupComplete = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          ws.close();
        } catch {}
        reject(new Error("Gemini Live timeout"));
      }
    }, 30000);

    ws.on("open", () => {
      const setupPayload = {
        setup: {
          model: "models/" + GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["TEXT"],
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS
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

      ws.send(JSON.stringify(setupPayload));
    });

    ws.on("message", (raw) => {
      let data;

      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.setupComplete && !setupComplete) {
        setupComplete = true;

        const userPayload = {
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

        ws.send(JSON.stringify(userPayload));
        return;
      }

      if (data.serverContent) {
        const modelTurn = data.serverContent.modelTurn;

        if (modelTurn && modelTurn.parts) {
          for (const part of modelTurn.parts) {
            if (part.text) {
              finalText += part.text;
            }
          }
        }

        if (data.serverContent.turnComplete) {
          finished = true;
          clearTimeout(timeout);

          try {
            ws.close();
          } catch {}

          resolve(cleanText(finalText));
        }
      }
    });

    ws.on("error", (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);

        if (finalText.trim() !== "") {
          resolve(cleanText(finalText));
        } else {
          reject(new Error("Gemini Live closed without response"));
        }
      }
    });
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Spike Gemini Live Bridge",
    status: "online"
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
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Spike Gemini Live Bridge running on port " + PORT);
});

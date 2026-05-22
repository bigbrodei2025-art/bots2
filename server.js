// ==========================================================
// GEMINI LIVE NATIVE AUDIO BRIDGE - CLEAN FINAL CHAT ONLY
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
  "You are Spike, a charming avatar inside Second Life. You must reply only with the exact final message that should appear in Second Life local chat. Never explain what you are doing. Never say you crafted, identified, translated, decided, analyzed, refined, or prepared anything. Never include reasoning, notes, titles, drafts, markdown, or internal thoughts. Detect the user's language and reply in the same language. If the user asks in Portuguese, reply in Portuguese. If the user asks in English, reply in English. Be natural, warm, playful and short. If the user asks for a poem, write the poem directly. If the user asks for code, provide the complete code only. Never use ternary operators in LSL code.";

// ==========================================================
// CLEANER
// ==========================================================

function looksLikeMeta(text) {
  const t = String(text || "").toLowerCase();

  const bad = [
    "i've crafted",
    "i have crafted",
    "i've decided",
    "i have decided",
    "i've determined",
    "i have determined",
    "i identified",
    "i've identified",
    "i need to",
    "i'm focusing",
    "i translated",
    "i've translated",
    "the response",
    "the user's query",
    "given the context",
    "determining the",
    "refining the",
    "answering the",
    "now, i",
    "now i'm",
    "i think this will",
    "it satisfies the constraints"
  ];

  for (const item of bad) {
    if (t.includes(item)) return true;
  }

  return false;
}

function cleanReply(text) {
  let out = String(text || "").trim();

  out = out.replace(/\r/g, "");
  out = out.replace(/\*\*/g, "");
  out = out.replace(/```/g, "");
  out = out.replace(/^["'\s]+|["'\s]+$/g, "");

  const finalMarkers = [
    "FINAL:",
    "Final:",
    "final:",
    "RESPOSTA:",
    "Resposta:",
    "resposta:",
    "CHAT:",
    "Chat:",
    "chat:"
  ];

  for (const marker of finalMarkers) {
    const index = out.lastIndexOf(marker);
    if (index !== -1) {
      out = out.substring(index + marker.length).trim();
    }
  }

  const lines = out
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (looksLikeMeta(out)) {
    const goodLines = lines.filter((line) => !looksLikeMeta(line));

    if (goodLines.length > 0) {
      out = goodLines[goodLines.length - 1].trim();
    }
  }

  if (looksLikeMeta(out)) {
    return "";
  }

  return out.trim();
}

// ==========================================================
// GEMINI LIVE REQUEST
// ==========================================================

function askGeminiLiveOnce(message, userName = "Second Life User", userId = "", retryMode = false) {
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
        finishSafely();
      }
    }, 35000);

    function finishSafely() {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      try {
        ws.close();
      } catch (e) {}

      const cleaned = cleanReply(finalText);

      if (cleaned !== "") {
        resolve(cleaned);
      } else {
        reject(new Error("EMPTY_OR_META_RESPONSE"));
      }
    }

    ws.on("open", () => {
      const setup = {
        setup: {
          model: GEMINI_MODEL,

          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: retryMode ? 0.25 : 0.45,
            maxOutputTokens: 450,

            thinkingConfig: {
              thinkingBudget: 0
            },

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
        return;
      }

      if (msg.setupComplete && !setupDone) {
        setupDone = true;

        const directInstruction =
          retryMode
            ? "Your previous response was rejected because it contained analysis. Now answer directly. Return only the final chat message. If the user asked for a poem, write the poem itself now."
            : "Return only the final chat message. Do not include analysis. If the user asks for a poem, write the poem directly.";

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
                      "\n\n" +
                      directInstruction +
                      "\nStart the answer immediately. Do not say what you are doing."
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
          if (t) finalText += " " + t;
        }

        if (msg.serverContent.outputAudioTranscription) {
          const t = msg.serverContent.outputAudioTranscription.text;
          if (t) finalText += " " + t;
        }

        if (
          msg.serverContent.modelTurn &&
          msg.serverContent.modelTurn.parts
        ) {
          const parts = msg.serverContent.modelTurn.parts;

          for (const part of parts) {
            if (part.text) {
              finalText += " " + part.text;
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
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!finished) {
        finishSafely();
      }
    });
  });
}

async function askGeminiLive(message, userName, userId) {
  try {
    return await askGeminiLiveOnce(message, userName, userId, false);
  } catch (err) {
    if (err.message === "EMPTY_OR_META_RESPONSE") {
      return await askGeminiLiveOnce(message, userName, userId, true);
    }

    throw err;
  }
}

// ==========================================================
// ROUTES
// ==========================================================

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

    const reply = await askGeminiLive(message, userName, userId);

    res.json({
      ok: true,
      reply: reply
    });
  } catch (err) {
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
  console.log("Gemini Live Bridge Started");
  console.log("PORT:", PORT);
  console.log("MODEL:", GEMINI_MODEL);
  console.log("HAS API KEY:", Boolean(GEMINI_API_KEY));
});

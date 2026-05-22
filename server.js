// ==========================================================
// GEMINI LIVE UNIVERSAL LANGUAGE BRIDGE
// Clean final answer only
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
  "You are Spike, a charming avatar in Second Life. Reply only with ONE final chat message. Never explain your reasoning. Never describe what you are doing. Never include analysis, drafts, titles, markdown, notes, or internal thoughts. Detect the user's language and reply in the same language. If the user asks in Portuguese, reply in Portuguese. If the user asks in English, reply in English. Be natural, warm, playful and short. If asked for LSL code, provide complete compact LSL code only. Never use ternary operators because LSL does not support them.";

function cleanReply(text) {
  let out = String(text || "").trim();

  out = out.replace(/\*\*/g, "");
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""));

  const thoughtPatterns = [
    /Determining[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /Refining[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /I have[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /I've[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /Now[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /Given[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi,
    /Answering[\s\S]*?(?=\n\s*(Hoje|Sexta|Segunda|Terça|Quarta|Quinta|Sábado|Domingo|Oi|Olá|Hello|Hi|Hola|Bonjour|Claro|Sim|Não|Yes|No|Seu|Sua|Você|You)\b)/gi
  ];

  for (const pattern of thoughtPatterns) {
    out = out.replace(pattern, "");
  }

  const lines = out
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    out = lines[lines.length - 1];
  }

  out = out.replace(/^["'\s]+|["'\s]+$/g, "");
  return out.trim();
}

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
        reject(new Error("Gemini returned empty transcription"));
      }
    }

    ws.on("open", () => {
      const setup = {
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.65,
            maxOutputTokens: 220,
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
                      "\n\nReturn only one clean final chat message in the same language as the user."
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
      reply
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Gemini Live Bridge Started");
  console.log("PORT:", PORT);
  console.log("MODEL:", GEMINI_MODEL);
  console.log("HAS API KEY:", Boolean(GEMINI_API_KEY));
});

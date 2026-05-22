// ==========================================================
// GEMINI LIVE NATIVE AUDIO + CLEAN TRANSCRIPTION BRIDGE
// Second Life -> Render -> Gemini Live -> Clean Text
// ==========================================================

import express from "express";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

// ==========================================================
// EXPRESS
// ==========================================================

const app = express();

app.use(
  express.json({
    limit: "1mb"
  })
);

// ==========================================================
// ENV
// ==========================================================

const PORT =
  process.env.PORT || 3000;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "models/gemini-2.5-flash-native-audio-latest";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||

  "You are Spike, a charming avatar in Second Life. " +
  "Reply ONLY with the final chat message. " +
  "Never explain your reasoning. " +
  "Never describe what you are doing. " +
  "Never include analysis. " +
  "Never include markdown. " +
  "Never say things like 'I have', 'I've', 'I need', 'Now'. " +
  "Speak naturally in the same language as the user. " +
  "Be warm, playful and short. " +
  "If asked for LSL code, provide complete compact LSL code only.";

// ==========================================================
// CLEAN REPLY
// ==========================================================

function cleanReply(text)
{
  let out =
    String(text || "").trim();

  // ========================================================
  // REMOVE MARKDOWN
  // ========================================================

  out =
    out.replace(/\*\*/g, "");

  // ========================================================
  // REMOVE COMMON AI THOUGHTS
  // ========================================================

  const badPatterns =
  [
    /I have successfully[\s\S]*/gi,
    /I've translated[\s\S]*/gi,
    /I'm focusing[\s\S]*/gi,
    /Now, I need[\s\S]*/gi,
    /Now I'm[\s\S]*/gi,
    /Given the context[\s\S]*/gi,
    /Answering the Question[\s\S]*/gi,
    /I think the translation[\s\S]*/gi
  ];

  for (const p of badPatterns)
  {
    out =
      out.replace(p, "");
  }

  // ========================================================
  // TRY TO KEEP ONLY FINAL MESSAGE
  // ========================================================

  const markers =
  [
    "Hoje é",
    "Seu nome é",
    "Oi",
    "Olá",
    "Claro",
    "Sim",
    "Não",
    "Você",
    "Eu",
    "Boa",
    "Que"
  ];

  for (const marker of markers)
  {
    const index =
      out.lastIndexOf(marker);

    if (index > 0)
    {
      out =
        out.substring(index).trim();

      break;
    }
  }

  // ========================================================

  out =
    out.replace(/^["'\s]+|["'\s]+$/g, "");

  return out.trim();
}

// ==========================================================
// GEMINI LIVE
// ==========================================================

function askGeminiLive(
  message,
  userName = "Second Life User",
  userId = ""
)
{
  return new Promise((resolve, reject) =>
  {
    if (!GEMINI_API_KEY)
    {
      reject(
        new Error(
          "Missing GEMINI_API_KEY"
        )
      );

      return;
    }

    // ======================================================
    // WEBSOCKET URL
    // ======================================================

    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1alpha." +
      "GenerativeService.BidiGenerateContent" +
      "?key=" +
      encodeURIComponent(
        GEMINI_API_KEY
      );

    // ======================================================

    const ws =
      new WebSocket(url);

    let finalText = "";

    let setupDone = false;
    let finished = false;
    let turnCompleteSeen = false;

    // ======================================================
    // TIMEOUT
    // ======================================================

    const timeout =
      setTimeout(() =>
      {
        if (!finished)
        {
          finished = true;

          try
          {
            ws.close();
          }
          catch(e){}

          finalText =
            cleanReply(finalText);

          if (
            finalText.trim() !== ""
          )
          {
            resolve(finalText);
          }
          else
          {
            reject(
              new Error(
                "Gemini timeout without transcription"
              )
            );
          }
        }
      }, 35000);

    // ======================================================
    // FINISH
    // ======================================================

    function finishSafely()
    {
      if (finished)
      {
        return;
      }

      finished = true;

      clearTimeout(timeout);

      try
      {
        ws.close();
      }
      catch(e){}

      finalText =
        cleanReply(finalText);

      if (
        finalText.trim() !== ""
      )
      {
        resolve(finalText);
      }
      else
      {
        reject(
          new Error(
            "Gemini returned empty transcription"
          )
        );
      }
    }

    // ======================================================
    // OPEN
    // ======================================================

    ws.on("open", () =>
    {
      console.log(
        "Gemini Live Connected"
      );

      const setup =
      {
        setup:
        {
          model:
            GEMINI_MODEL,

          generationConfig:
          {
            responseModalities:
            [
              "AUDIO"
            ],

            temperature: 0.85,

            maxOutputTokens: 350,

            speechConfig:
            {
              voiceConfig:
              {
                prebuiltVoiceConfig:
                {
                  voiceName:
                    "Kore"
                }
              }
            }
          },

          outputAudioTranscription:
          {}
        }
      };

      console.log(
        "Sending setup..."
      );

      ws.send(
        JSON.stringify(setup)
      );
    });

    // ======================================================
    // MESSAGE
    // ======================================================

    ws.on("message", (data) =>
    {
      let msg;

      try
      {
        msg =
          JSON.parse(
            data.toString()
          );
      }
      catch(err)
      {
        console.log(
          "Invalid JSON:",
          data.toString()
        );

        return;
      }

      // ====================================================
      // SETUP COMPLETE
      // ====================================================

      if (
        msg.setupComplete
        && !setupDone
      )
      {
        setupDone = true;

        const userMessage =
        {
          clientContent:
          {
            turns:
            [
              {
                role: "user",

                parts:
                [
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

                      "\n\nImportant: Reply ONLY with the final chat message."
                  }
                ]
              }
            ],

            turnComplete: true
          }
        };

        console.log(
          "Sending user message..."
        );

        ws.send(
          JSON.stringify(
            userMessage
          )
        );

        return;
      }

      // ====================================================
      // SERVER CONTENT
      // ====================================================

      if (msg.serverContent)
      {
        // ==================================================
        // TRANSCRIPTIONS
        // ==================================================

        if (
          msg.serverContent
          .outputTranscription
        )
        {
          const t =
            msg.serverContent
            .outputTranscription
            .text;

          if (t)
          {
            finalText +=
              " " + t;
          }
        }

        if (
          msg.serverContent
          .outputAudioTranscription
        )
        {
          const t =
            msg.serverContent
            .outputAudioTranscription
            .text;

          if (t)
          {
            finalText +=
              " " + t;
          }
        }

        // ==================================================
        // MODEL TURN PARTS
        // ==================================================

        if (
          msg.serverContent.modelTurn &&
          msg.serverContent.modelTurn.parts
        )
        {
          const parts =
            msg.serverContent
            .modelTurn
            .parts;

          for (const part of parts)
          {
            if (part.text)
            {
              finalText +=
                " " + part.text;
            }
          }
        }

        // ==================================================
        // TURN COMPLETE
        // ==================================================

        if (
          msg.serverContent.turnComplete &&
          !turnCompleteSeen
        )
        {
          turnCompleteSeen = true;

          console.log(
            "Turn complete. Waiting final transcription..."
          );

          setTimeout(() =>
          {
            finishSafely();
          }, 1500);
        }
      }
    });

    // ======================================================
    // ERROR
    // ======================================================

    ws.on("error", (err) =>
    {
      console.log(
        "WebSocket Error:",
        err.message
      );

      if (!finished)
      {
        finished = true;

        clearTimeout(timeout);

        reject(err);
      }
    });

    // ======================================================
    // CLOSE
    // ======================================================

    ws.on("close", (code, reason) =>
    {
      console.log(
        "WebSocket Closed:",
        code,
        reason.toString()
      );

      if (!finished)
      {
        finished = true;

        clearTimeout(timeout);

        finalText =
          cleanReply(finalText);

        if (
          finalText.trim() !== ""
        )
        {
          resolve(finalText);
        }
        else
        {
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

app.get("/", (req, res) =>
{
  res.send(
    "Gemini Live Bridge Online"
  );
});

// ==========================================================

app.get("/health", (req, res) =>
{
  res.json(
  {
    ok: true,

    model:
      GEMINI_MODEL,

    hasKey:
      Boolean(
        GEMINI_API_KEY
      )
  });
});

// ==========================================================

app.get("/models", async (req, res) =>
{
  try
  {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?key=" +
        encodeURIComponent(
          GEMINI_API_KEY
        )
      );

    const data =
      await response.json();

    res.json(data);
  }
  catch(err)
  {
    res.status(500).json(
    {
      ok: false,

      error:
        err.message
    });
  }
});

// ==========================================================

app.post("/ask", async (req, res) =>
{
  try
  {
    const message =
      String(
        req.body.message || ""
      ).trim();

    const userName =
      String(
        req.body.userName ||
        "Second Life User"
      ).trim();

    const userId =
      String(
        req.body.userId || ""
      ).trim();

    if (!message)
    {
      res.status(400).json(
      {
        ok: false,

        error:
          "Missing message"
      });

      return;
    }

    console.log(
      "ASK:",
      userName,
      message
    );

    const reply =
      await askGeminiLive(
        message,
        userName,
        userId
      );

    res.json(
    {
      ok: true,

      reply: reply
    });
  }
  catch(err)
  {
    console.error(
      "ASK ERROR:",
      err.message
    );

    res.status(500).json(
    {
      ok: false,

      error:
        err.message
    });
  }
});

// ==========================================================
// START
// ==========================================================

app.listen(PORT, () =>
{
  console.log(
    "=================================="
  );

  console.log(
    "Gemini Live Native Audio Bridge Started"
  );

  console.log(
    "PORT:",
    PORT
  );

  console.log(
    "MODEL:",
    GEMINI_MODEL
  );

  console.log(
    "HAS API KEY:",
    Boolean(
      GEMINI_API_KEY
    )
  );

  console.log(
    "=================================="
  );
});

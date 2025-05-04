const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const { PREFIX } = require("./config");

const estadoEnvio = {};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info_baileys"));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") console.log("✅ Bot conectado com sucesso!");
    if (
      connection === "close" &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      console.log("🔁 Reconectando...");
      startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const msg = m.message.conversation || m.message.extendedTextMessage?.text || "";

    if (msg.toLowerCase().includes("oi")) {
      await sock.sendMessage(sender, { text: "Olá, estou ativo!" });
      return;
    }

    if (msg.startsWith(`${PREFIX}enviar`)) {
      estadoEnvio[sender] = { etapa: "numero" };
      await sock.sendMessage(sender, { text: "📲 Informe o número do cliente por favor! (ex: 5511999999999) ou envie o CSV." });
      return;
    }

    if (estadoEnvio[sender]) {
      const estado = estadoEnvio[sender];

      if (m.message.documentMessage) {
        const fileName = m.message.documentMessage.fileName || "contatos.csv";
        const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
        const caminho = path.join(__dirname, "mensagens", fileName);
        fs.writeFileSync(caminho, buffer);
        estado.numeros = extrairNumerosDoCSV(caminho);
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, { text: `📄 CSV com ${estado.numeros.length} números recebido. Agora envie a mensagem.` });
        return;
      }

      if (estado.etapa === "numero") {
        estado.numeros = [msg.replace(/\D/g, "")];
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, { text: "✉️ Agora envie a mensagem de texto." });
        return;
      }

      if (estado.etapa === "mensagem") {
        estado.mensagem = msg;
        estado.etapa = "midia";
        await sock.sendMessage(sender, { text: "📎 Envie uma imagem/vídeo/documento ou escreva 'pular' para enviar sem mídia." });
        return;
      }

      if (estado.etapa === "midia") {
        if (msg.toLowerCase() === "pular") {
          await enviarMensagens(sock, estado.numeros, estado.mensagem);
        } else if (
          m.message.imageMessage ||
          m.message.videoMessage ||
          m.message.documentMessage
        ) {
          const tipo =
            m.message.imageMessage
              ? "image"
              : m.message.videoMessage
              ? "video"
              : "document";

          const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });

          await enviarMensagens(sock, estado.numeros, estado.mensagem, buffer, tipo);
        }

        delete estadoEnvio[sender];
        return;
      }
    }
  });

  // API EXPRESS
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/", (req, res) => {
    res.send("🟢 Bot está rodando com API aberta.");
  });

  app.post("/enviar", async (req, res) => {
    const { numeros, mensagem, midiaBase64, tipo } = req.body;

    if (!numeros || !mensagem) {
      return res.status(400).json({ ok: false, msg: "Faltam dados" });
    }

    let midiaBuffer = null;
    if (midiaBase64) {
      try {
        midiaBuffer = Buffer.from(midiaBase64, "base64");
      } catch (e) {
        return res.status(400).json({ ok: false, msg: "Mídia inválida" });
      }
    }

    try {
      await enviarMensagens(sock, numeros, mensagem, midiaBuffer, tipo || "text");
      return res.json({ ok: true, msg: "Mensagens enviadas com sucesso" });
    } catch (e) {
      return res.status(500).json({ ok: false, msg: e.message });
    }
  });

  app.listen(process.env.PORT || 3000, () => {
    console.log("🌐 Servidor HTTP do bot iniciado");
  });
}

function extrairNumerosDoCSV(caminho) {
  try {
    const linhas = fs.readFileSync(caminho, "utf8").split("\n");
    return linhas
      .map((linha) => linha.trim().replace(/\D/g, ""))
      .filter((numero) => numero.length >= 11);
  } catch (e) {
    console.error("Erro ao ler CSV:", e);
    return [];
  }
}

async function enviarMensagens(sock, numeros, mensagem, midia = null, tipo = "text") {
  for (const numero of numeros) {
    const jid = `${numero}@s.whatsapp.net`;

    try {
      if (midia) {
        await sock.sendMessage(jid, { [tipo]: midia, caption: mensagem });
      } else {
        await sock.sendMessage(jid, { text: mensagem });
      }

      console.log(`✅ Mensagem enviada para ${numero}`);
    } catch (e) {
      console.error(`❌ Erro ao enviar para ${numero}:`, e.message);
    }
  }
}

startBot();

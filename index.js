const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const P = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 8080;

let sock;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve o index.html diretamente

// Rota para envio de mensagem
app.post("/enviar", async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!numero || !mensagem) {
    return res.status(400).json({ erro: "Número e mensagem obrigatórios." });
  }

  try {
    await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem });
    res.json({ sucesso: true, msg: "Mensagem enviada com sucesso!" });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao enviar mensagem", detalhe: e.message });
  }
});

// Iniciar o bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info_baileys"));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") console.log("✅ Bot conectado!");
    if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      console.log("🔁 Reconectando...");
      startBot();
    }
  });
}

startBot();
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});

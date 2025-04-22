const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const config = require("./config");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, "auth_info_baileys")
  );
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexão fechada, reconectando:", shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ Bot conectado!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const msgText =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      "";

    const sender = m.key.remoteJid;
    const command = msgText.startsWith(config.PREFIX)
      ? msgText.slice(1).split(" ")[0].toLowerCase()
      : "";

    if (command === "ping") {
      await sock.sendMessage(sender, { text: "🏓 Pong!" }, { quoted: m });
    }
  });
}

startBot();

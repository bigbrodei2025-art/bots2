const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const fs = require("fs");
const path = require("path");

let estadoEnvio = {};

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

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log("✅ Bot conectado com sucesso!");
    }
    if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const msg = m.message.conversation || m.message.extendedTextMessage?.text || "";

    // Se o comando de enviar for recebido
    if (msg.startsWith("!enviar")) {
      estadoEnvio[sender] = { etapa: "numero" };
      await sock.sendMessage(sender, { text: "📲 Informe o número do cliente (ex: 5511999999999) ou envie o CSV." });
      return;
    }

    // Se estiver no fluxo de envio
    if (estadoEnvio[sender]) {
      const estado = estadoEnvio[sender];

      if (m.message.documentMessage) {
        // CSV
        const fileName = m.message.documentMessage.fileName || "contatos.csv";
        const buffer = await sock.downloadMediaMessage(m);
        const caminho = path.join(__dirname, "mensagens", fileName);
        fs.writeFileSync(caminho, buffer);
        estado.numeros = extrairNumerosDoCSV(caminho);
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, { text: `📄 CSV recebido com ${estado.numeros.length} números. Agora envie a mensagem.` });
        return;
      }

      // Verifica se a etapa está correta antes de processar a mensagem
      if (estado.etapa === "numero") {
        estado.numeros = [msg.replace(/\D/g, "")];
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, { text: "✉️ Agora envie a mensagem de texto." });
        return;
      }

      if (estado.etapa === "mensagem") {
        estado.mensagem = msg;
        estado.etapa = "mídia";
        await sock.sendMessage(sender, { text: "📎 Agora envie uma imagem/vídeo/documento ou escreva 'pular' para enviar sem mídia." });
        return;
      }

      if (estado.etapa === "mídia") {
        // Se o usuário enviar "pular", continua sem mídia
        if (msg.toLowerCase() === "pular") {
          await enviarMensagens(sock, estado.numeros, estado.mensagem);
        } else if (m.message.imageMessage || m.message.videoMessage || m.message.documentMessage) {
          const buffer = await sock.downloadMediaMessage(m);
          estado.midia = buffer;
          estado.tipo = m.message.imageMessage ? "image" : m.message.videoMessage ? "video" : "document";
          await enviarMensagens(sock, estado.numeros, estado.mensagem, estado.midia, estado.tipo);
        } else {
          // Mensagem de erro caso a mídia não seja recebida
          await sock.sendMessage(sender, { text: "📎 Envie uma imagem/vídeo/documento ou escreva 'pular' para enviar sem mídia." });
        }
        delete estadoEnvio[sender];
        return;
      }
    }
  });
}

function extrairNumerosDoCSV(caminho) {
  const linhas = fs.readFileSync(caminho, "utf8").split("\n");
  const numeros = linhas.map(l => l.trim().replace(/\D/g, "")).filter(n => n.length >= 11);
  return numeros;
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
    } catch (err) {
      console.error(`❌ Erro ao enviar para ${numero}:`, err);
    }
  }
}

startBot();

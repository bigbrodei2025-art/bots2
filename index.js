// --- Imports e Configurações Iniciais ---
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const qrcode = require("qrcode");
const crypto = require("crypto");
require("dotenv").config();

// --- Validação de Variáveis de Ambiente ---
const requiredEnv = ["MONGO_URL", "SHOPEE_APP_ID", "SHOPEE_SECRET", "GOOGLE_API_KEY"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Variável de ambiente ausente: ${key}`);
    process.exit(1);
  }
});

const { PREFIX, ADMIN_JIDS } = require("./config");

// --- Configuração de API ---
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent";
const PROMPT_IA = `Atue como um especialista em vendas no varejo — criativo, persuasivo e empolgado! Escreva um parágrafo curto (máximo 4 linhas), com emojis, para vender o seguinte produto: {nome_produto}. Certifique-se de entender corretamente o tipo de produto (ex: não confundir prancha de cabelo com prancha de surfe). Não comece o texto repetindo o nome do produto.`;

// --- Funções Auxiliares ---
async function gerarAssinaturaShopee(timestamp, payload) {
  const stringParaAssinatura = `${SHOPEE_APP_ID}${timestamp}${payload}${SHOPEE_SECRET}`;
  return crypto.createHash("sha256").update(stringParaAssinatura).digest("hex");
}

async function fazerRequisicaoShopee(query) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query });
  const assinatura = await gerarAssinaturaShopee(timestamp, payload);
  const headers = {
    Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${assinatura}`,
    "Content-Type": "application/json"
  };
  try {
    const resposta = await axios.post(SHOPEE_API_URL, payload, { headers, timeout: 30000 });
    resposta.data.status = 200;
    return resposta.data;
  } catch (error) {
    console.error("❌ Erro na requisição Shopee:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    return { errors: [{ message: "Erro na requisição Shopee" }] };
  }
}

function normalizarPreco(valor) {
  try {
    const v = parseFloat(valor);
    return v >= 1000 ? v / 100 : v;
  } catch {
    return 0.0;
  }
}

async function obterProdutoPorId(itemId, shopId) {
  const query = `{
    productOfferV2(itemId: "${itemId}", shopId: "${shopId}") {
      nodes {
        itemId productName priceMin offerLink imageUrl priceDiscountRate
      }
    }
  }`;
  const resultado = await fazerRequisicaoShopee(query);
  if (resultado.errors) return null;

  const nodes = resultado.data?.productOfferV2?.nodes;
  if (!nodes || !nodes.length) return null;

  const produto = nodes[0];
  const precoPromocional = normalizarPreco(produto.priceMin);
  const desconto = produto.priceDiscountRate || 0;

  let precoOriginal = precoPromocional;
  if (desconto > 0) precoOriginal = precoPromocional / (1 - desconto / 100);
  precoOriginal = Math.max(precoOriginal, precoPromocional);

  return { ...produto, precoMin: precoPromocional, precoOriginal };
}

async function gerarMensagemPromocional(nomeProduto) {
  const promptCompleto = PROMPT_IA.replace("{nome_produto}", nomeProduto);
  try {
    const url = `${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`;
    const dados = { contents: [{ parts: [{ text: promptCompleto }] }] };
    const resposta = await axios.post(url, dados, { timeout: 15000 });
    const mensagem = resposta.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (mensagem && mensagem.toLowerCase().startsWith(nomeProduto.toLowerCase())) {
      return mensagem.substring(nomeProduto.length).replace(/^[\s-:,.]+/, "").trim();
    }
    return mensagem || "Essa oferta está imperdível! 🎉";
  } catch (e) {
    console.error("❌ Erro ao gerar mensagem com Google AI:", e.response?.data || e.message);
    return "Essa oferta está imperdível! 🎉";
  }
}

async function parseUrl(url) {
  if (url.includes("s.shopee.com.br") || url.includes("shope.ee")) {
    try {
      const response = await axios.head(url, { maxRedirects: 10, timeout: 5000 });
      url = response.request.res.responseUrl;
      console.log("Link encurtado resolvido para:", url);
    } catch (error) {
      console.error("❌ Erro ao resolver link encurtado:", error.message);
    }
  }
  const patterns = [
    /product\/(\d+)\/(\d+)/,
    /itemId=(\d+).*shopId=(\d+)/,
    /i\.(\d+)\.(\d+)/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return { itemId: m[2] || m[1], shopId: m[1] };
  }
  return { itemId: null, shopId: null };
}

function extrairNumerosDoCSV(caminho) {
  try {
    return fs.readFileSync(caminho, "utf8")
      .split("\n")
      .map((l) => l.trim().replace(/\D/g, ""))
      .filter((n) => n.length >= 11);
  } catch (e) {
    console.error("Erro lendo CSV:", e);
    return [];
  }
}

async function enviarMensagens(sock, numeros, mensagem, midia = null, tipo = "text") {
  for (const numero of numeros) {
    const jid = `${numero}@s.whatsapp.net`;
    try {
      if (midia) await sock.sendMessage(jid, { [tipo]: midia, caption: mensagem });
      else await sock.sendMessage(jid, { text: mensagem });
      console.log(`✅ Mensagem enviada para ${numero}`);
    } catch (e) {
      console.error(`❌ Erro ao enviar para ${numero}:`, e.message);
    }
  }
}

// --- Configuração do Servidor ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

const PORT = process.env.PORT || 3000;
const client = new MongoClient(process.env.MONGO_URL);

let sock, socketCliente, qrState = null, reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

const estadoEnvio = {};

// --- Rotas ---
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.post("/connect-bot", async (req, res) => {
  console.log("Solicitação de conexão recebida.");
  await connectToWhatsApp();
  res.json({ message: "Tentativa de conexão iniciada." });
});
app.post("/disconnect-bot", async (req, res) => {
  if (sock) {
    await sock.logout();
    io.emit("log", "Bot desconectado manualmente.");
    io.emit("init", { isConnected: false });
    res.json({ message: "Bot desconectado." });
  } else res.json({ message: "Bot já estava desconectado." });
});

// --- Sessão no Mongo ---
async function saveSessionToMongo(sessionPath) {
  try {
    await client.connect();
    const col = client.db("baileys").collection("sessions");
    for (const f of fs.readdirSync(sessionPath)) {
      const content = fs.readFileSync(path.join(sessionPath, f), "utf8");
      await col.updateOne({ fileName: f }, { $set: { content } }, { upsert: true });
    }
    console.log("✅ Sessão salva no MongoDB.");
  } catch (e) {
    console.error("❌ Erro ao salvar sessão:", e);
  }
}

async function restoreSessionFromMongo(sessionPath) {
  try {
    await client.connect();
    const docs = await client.db("baileys").collection("sessions").find({}).toArray();
    if (!docs.length) return false;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(sessionPath, d.fileName), d.content);
    console.log("✅ Sessão restaurada do Mongo.");
    return true;
  } catch (e) {
    console.error("❌ Erro ao restaurar sessão:", e);
    return false;
  }
}

// --- Conexão WhatsApp ---
async function connectToWhatsApp() {
  const sessionPath = path.join(__dirname, "auth_info_baileys");
  await restoreSessionFromMongo(sessionPath);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const customSaveCreds = async () => {
    await saveCreds();
    await saveSessionToMongo(sessionPath);
  };
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, logger: P({ level: "silent" }), auth: state });
  sock.ev.on("creds.update", customSaveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { reconnectAttempts = 0; qrState = qr; if (socketCliente) updateQR("qr"); }
    if (connection === "close") {
      reconnectAttempts++;
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        await client.db("baileys").collection("sessions").deleteMany({});
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        reconnectAttempts = 0; qrState = null;
        connectToWhatsApp();
      } else setTimeout(() => connectToWhatsApp(), Math.min(10000, reconnectAttempts * 2000));
    } else if (connection === "open") {
      reconnectAttempts = 0; qrState = null;
      if (socketCliente) updateQR("connected");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    const msg = m?.message?.conversation || m?.message?.extendedTextMessage?.text || "";
    if (!m.message || m.key.fromMe) return;
    const sender = m.key.remoteJid;

    if (msg.startsWith("!ping")) {
      await sock.sendPresenceUpdate("composing", sender);
      await sock.sendMessage(sender, { text: `🏓 PONG! Online: ${new Date().toLocaleString()}` });
      return;
    }

    // fluxo de envio em massa
    if (msg.startsWith(`${PREFIX}enviar`)) {
      estadoEnvio[sender] = { etapa: "numero" };
      return sock.sendMessage(sender, { text: "📲 Forneça o número ou envie o CSV." });
    }

    if (estadoEnvio[sender]) {
      const estado = estadoEnvio[sender];
      if (m.message.documentMessage) {
        const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
        const filePath = path.join(__dirname, "mensagens", m.message.documentMessage.fileName || "contacts.csv");
        fs.writeFileSync(filePath, buffer);
        estado.numeros = extrairNumerosDoCSV(filePath);
        estado.etapa = "mensagem";
        return sock.sendMessage(sender, { text: `📄 CSV com ${estado.numeros.length} números. Envie a mensagem.` });
      }
      if (estado.etapa === "numero") {
        estado.numeros = [msg.replace(/\D/g, "")]; estado.etapa = "mensagem";
        return sock.sendMessage(sender, { text: "✉️ Agora envie a mensagem." });
      }
      if (estado.etapa === "mensagem") {
        estado.mensagem = msg; estado.etapa = "midia";
        return sock.sendMessage(sender, { text: "📎 Envie mídia ou digite 'pular'." });
      }
      if (estado.etapa === "midia") {
        if (msg.toLowerCase() === "pular") await enviarMensagens(sock, estado.numeros, estado.mensagem);
        else if (m.message.imageMessage || m.message.videoMessage || m.message.documentMessage) {
          const tipo = m.message.imageMessage ? "image" : m.message.videoMessage ? "video" : "document";
          const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
          await enviarMensagens(sock, estado.numeros, estado.mensagem, buffer, tipo);
        }
        delete estadoEnvio[sender];
        return sock.sendMessage(sender, { text: "Mensagens enviadas!" });
      }
    }

    const url_info = await parseUrl(msg.trim());
    if (url_info.itemId && url_info.shopId) {
      await sock.sendPresenceUpdate("composing", sender);
      await sock.sendMessage(sender, { text: "Buscando produto, aguarde..." });
      const produto = await obterProdutoPorId(url_info.itemId, url_info.shopId);
      if (!produto) return sock.sendMessage(sender, { text: "Produto não encontrado. 😔" });

      const texto = `🔥 *${produto.productName}*\n*De* ~~R$ ${produto.precoOriginal.toFixed(2)}~~\n💰 *Por R$ ${produto.precoMin.toFixed(2)}* 😱\n(${produto.priceDiscountRate}% OFF)\n\n${await gerarMensagemPromocional(produto.productName)}\n\n🛒 *Compre agora* 👉 ${produto.offerLink}\n\n⚠️ _Promoção sujeita a alterações._`;
      if (produto.imageUrl) await sock.sendMessage(sender, { image: { url: produto.imageUrl }, caption: texto });
      else await sock.sendMessage(sender, { text: texto });
    }
  });
}

// --- Socket.IO ---
const isConnected = () => !!sock?.user;
io.on("connection", (socket) => {
  socketCliente = socket;
  if (isConnected()) updateQR("connected");
  else if (qrState) updateQR("qr");
  else updateQR("loading");
});

function updateQR(status) {
  if (!socketCliente) return;
  if (status === "qr" && qrState) {
    qrcode.toDataURL(qrState, (err, url) => {
      if (!err) socketCliente.emit("qr", url);
    });
  } else if (status === "connected") {
    socketCliente.emit("qrstatus", "./assets/check.svg");
    socketCliente.emit("log", "Usuário conectado");
    const { id, name } = sock?.user || {};
    socketCliente.emit("user", `${id || ""} ${name || ""}`);
  } else if (status === "loading") {
    socketCliente.emit("qrstatus", "./assets/loader.gif");
  }
}

// --- Encerramento Limpo ---
process.on("SIGINT", async () => {
  console.log("Encerrando servidor...");
  await client.close();
  process.exit(0);
});

connectToWhatsApp().catch((err) => console.error("Erro inesperado:", err));
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Imports e Configurações Iniciais ---
const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
    useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const { MongoClient } = require('mongodb');
const P = require("pino");
const fs = require("fs");
const path = require("path");
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const axios = require('axios');
const qrcode = require("qrcode");
const crypto = require('crypto');
require('dotenv').config();

const { PREFIX, ADMIN_JIDS } = require("./config");

// --- Credenciais e Lógica das APIs (Shopee e Google Gemini) ---
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent";
const PROMPT_IA = `Aja como um especialista em vendas no varejo. Você é criativo, persuasivo e empolgado. Escreva um parágrafo curto e conciso, de no máximo 4 linhas, com emojis, para vender o seguinte produto: {nome_produto}. Não repita o nome do produto no início.`;

async function gerarAssinaturaShopee(timestamp, payload) {
    const stringParaAssinatura = `${SHOPEE_APP_ID}${timestamp}${payload}${SHOPEE_SECRET}`;
    return crypto.createHash('sha256').update(stringParaAssinatura).digest('hex');
}

async function fazerRequisicaoShopee(query) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ query: query });
    const assinatura = await gerarAssinaturaShopee(timestamp, payload);
    const headers = {
        'Authorization': `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${assinatura}`,
        'Content-Type': 'application/json'
    };

    try {
        const resposta = await axios.post(SHOPEE_API_URL, payload, { headers: headers, timeout: 30000 });
        resposta.data.status = 200;
        return resposta.data;
    } catch (error) {
        console.error("❌ Erro na requisição Shopee:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return { errors: [{ message: "Erro na requisição Shopee" }] };
    }
}

// CORREÇÃO: Função de normalização de preço aprimorada
function normalizarPreco(valor) {
    try {
        const v = parseFloat(valor);
        // Se o valor for muito grande, assuma que são centavos e divida por 100
        if (v >= 1000) { 
            return v / 100;
        }
        // Se o valor for menor, mantenha como está
        return v;
    } catch (e) {
        return 0.0;
    }
}

async function obterProdutoPorId(itemId, shopId) {
    const query = `{
        productOfferV2(itemId: "${itemId}", shopId: "${shopId}") {
            nodes {
                itemId
                productName
                priceMin
                offerLink
                imageUrl
                priceDiscountRate
            }
        }
    }`;
    const resultado = await fazerRequisicaoShopee(query);
    if (resultado.errors) {
        return null;
    }

    const nodes = resultado.data?.productOfferV2?.nodes;
    if (!nodes || nodes.length === 0) {
        return null;
    }

    const produto = nodes[0];
    const precoPromocional = normalizarPreco(produto.priceMin);
    const desconto = produto.priceDiscountRate || 0;
    
    let precoOriginal = precoPromocional;
    if (desconto > 0) {
        precoOriginal = precoPromocional / (1 - desconto / 100);
    }
    
    precoOriginal = Math.max(precoOriginal, precoPromocional);

    return {
        ...produto,
        precoMin: precoPromocional,
        precoOriginal: precoOriginal,
    };
}

async function gerarMensagemPromocional(nomeProduto) {
    const promptCompleto = PROMPT_IA.replace("{nome_produto}", nomeProduto);
    try {
        const url = `${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`;
        const dados = { contents: [{ parts: [{ text: promptCompleto }] }] };
        const resposta = await axios.post(url, dados);
        const mensagem = resposta.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (mensagem && mensagem.toLowerCase().startsWith(nomeProduto.toLowerCase())) {
            return mensagem.substring(nomeProduto.length).replace(/^[\s-:,.]+/, '').trim();
        }
        return mensagem || "Essa oferta está imperdível! 🎉";
    } catch (e) {
        console.error("❌ Erro ao gerar mensagem com Google AI:", e.response?.data || e.message);
        return "Essa oferta está imperdível! 🎉";
    }
}

// Lida com links encurtados
async function parseUrl(url) {
    if (url.includes("s.shopee.com.br")) {
        try {
            const response = await axios.head(url, { maxRedirects: 10, timeout: 5000 });
            url = response.request.res.responseUrl;
            console.log("Link encurtado resolvido para:", url);
        } catch (error) {
            console.error("❌ Erro ao resolver link encurtado:", error.message);
            return { itemId: null, shopId: null };
        }
    }

    const productMatch = url.match(/product\/(\d+)\/(\d+)/);
    if (productMatch) {
        return { itemId: productMatch[2], shopId: productMatch[1] };
    }
    const queryMatch = url.match(/itemId=(\d+).*shopId=(\d+)/);
    if (queryMatch) {
        return { itemId: queryMatch[1], shopId: queryMatch[2] };
    }
    const iMatch = url.match(/i\.(\d+)\.(\d+)/);
    if (iMatch) {
        return { itemId: iMatch[2], shopId: iMatch[1] };
    }
    const nameMatch = url.match(/shopee\.com\.br\/([a-zA-Z0-9%\-]+)-i\.(\d+)\.(\d+)/);
    if (nameMatch) {
        return { shopId: nameMatch[2], itemId: nameMatch[3] };
    }
    return { itemId: null, shopId: null };
}

// --- Persistência de Dados do Usuário ---
const usuariosDB = {};
const DB_FILE_PATH = path.join(__dirname, 'usuariosDB.json');

function carregarDB() {
    if (fs.existsSync(DB_FILE_PATH)) {
        try {
            const data = fs.readFileSync(DB_FILE_PATH, 'utf8');
            Object.assign(usuariosDB, JSON.parse(data || '{}'));
            console.log("✅ User DB loaded successfully.");
        } catch (e) {
            console.error("❌ Error loading user DB:", e);
            Object.assign(usuariosDB, {});
        }
    } else {
        console.log("ℹ️ User DB file not found, a new one will be created.");
    }
}

function salvarDB() {
    try {
        fs.writeFileSync(DB_FILE_PATH, JSON.stringify(usuariosDB, null, 2), 'utf8');
        console.log("✅ User DB saved successfully.");
    } catch (e) {
        console.error("❌ Error saving user DB:", e);
    }
}

carregarDB();

const estadoEnvio = {};
const estadoShopee = {};

const PORT = process.env.PORT || 3000;

// Variáveis para gerenciar o estado da conexão e do QR code
let sock;
let qrDinamic;
let soket;
let qrState = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// --- Configuração do MongoDB para a sessão ---
const MONGO_URL = process.env.MONGO_URL;
const client = new MongoClient(MONGO_URL);

// --- Configuração do Express e Rotas da Interface ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rota para o seu index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rotas de API para a interface HTML
app.post('/connect-bot', async (req, res) => {
    console.log("Solicitação de conexão recebida da interface.");
    await connectToWhatsApp();
    res.json({ message: "Tentativa de conexão iniciada. Verifique a interface para o QR code." });
});

app.post('/disconnect-bot', async (req, res) => {
    console.log("Solicitação de desconexão recebida da interface.");
    if (sock) {
        await sock.logout();
        io.emit('log', 'Bot desconectado manualmente.');
        io.emit('init', { isConnected: false });
        res.json({ message: "Bot desconectado." });
    } else {
        res.json({ message: "O bot já estava desconectado." });
    }
});

app.post('/clear-session', async (req, res) => {
    console.log("Solicitação para limpar a sessão recebida da interface.");
    try {
        if (sock && sock.ws.readyState !== sock.ws.CLOSED) {
            sock.end();
            console.log("Bot desconectado via 'end()'.");
        }
        
        await client.connect();
        const database = client.db('baileys');
        const collection = database.collection('sessions');
        await collection.deleteMany({});
        
        const sessionPath = path.join(__dirname, 'auth_info_baileys');
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        console.log("✅ Sessão do MongoDB e arquivos locais apagados com sucesso.");
        qrState = null;
        reconnectAttempts = 0;
        
        res.json({ success: true, message: "Sessão apagada. O bot tentará conectar novamente com um novo QR Code." });
        setTimeout(() => connectToWhatsApp(), 2000);
    } catch (e) {
        console.error("❌ Erro ao apagar a sessão:", e);
        res.status(500).json({ success: false, message: "Erro ao apagar a sessão." });
    }
});

// --- Funções para gerenciar o backup da sessão no MongoDB ---
const saveSessionToMongo = async (sessionPath) => {
    try {
        await client.connect();
        const database = client.db('baileys');
        const collection = database.collection('sessions');
        const files = fs.readdirSync(sessionPath);
        for (const file of files) {
            const filePath = path.join(sessionPath, file);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                await collection.updateOne(
                    { fileName: file },
                    { $set: { content: content } },
                    { upsert: true }
                );
            }
        }
        console.log("✅ Sessão local salva no MongoDB com sucesso.");
    } catch (e) {
        console.error("❌ Erro ao salvar a sessão no MongoDB:", e);
    }
};

const restoreSessionFromMongo = async (sessionPath) => {
    try {
        await client.connect();
        const database = client.db('baileys');
        const collection = database.collection('sessions');
        const documents = await collection.find({}).toArray();

        if (documents.length > 0) {
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            for (const doc of documents) {
                fs.writeFileSync(path.join(sessionPath, doc.fileName), doc.content);
            }
            console.log("✅ Sessão restaurada do MongoDB para o disco local.");
            return true;
        } else {
            console.log("ℹ️ Nenhuma sessão encontrada no MongoDB.");
            return false;
        }
    } catch (e) {
        console.error("❌ Erro ao restaurar a sessão do MongoDB:", e);
        return false;
    }
};

// --- Função de Conexão do Bot de WhatsApp ---
async function connectToWhatsApp() {
    const sessionPath = path.join(__dirname, 'auth_info_baileys');
    
    const sessionRestored = await restoreSessionFromMongo(sessionPath);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const customSaveCreds = async () => {
        await saveCreds();
        await saveSessionToMongo(sessionPath);
    };

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
    });

    sock.ev.on("creds.update", customSaveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log("Status de conexão atualizado:", { connection, qr: !!qr });
        
        if (qr) {
            reconnectAttempts = 0;
            qrDinamic = qr;
            qrState = qr;
            if (soket) {
                updateQR("qr");
            }
        }
        
        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            
            reconnectAttempts++;
            console.log(`Tentativa de reconexão: ${reconnectAttempts}`);

            if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                console.log("Sessão inválida ou tentativas de reconexão esgotadas. Apagando sessão e gerando novo QR Code.");
                
                await client.connect();
                const database = client.db('baileys');
                const collection = database.collection('sessions');
                await collection.deleteMany({});
                
                const authPath = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                
                qrState = null;
                reconnectAttempts = 0;
                
                connectToWhatsApp();
            } else {
                console.log(`Conexão fechada ou perdida. Tentando reconectar...`);
                setTimeout(() => connectToWhatsApp(), 2000);
            }
        } else if (connection === "open") {
            console.log("conexão aberta");
            qrState = null;
            reconnectAttempts = 0;
            if (soket) {
                updateQR("connected");
            }
        }
    });

    // --- Lógica Principal do Processamento de Mensagens do WhatsApp ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        const msg = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const mensagemMinuscula = msg.toLowerCase();

        // --- Lógica de envio de mensagens em massa ---
        if (msg.startsWith("!ping")) {
            const tempoAtual = new Date();
            const responseText = `🏓 PONG! \nStatus: Online\nCurrent Time: ${tempoAtual.toLocaleString()}`;
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: responseText });
            return;
        }
    
        if (msg.startsWith(`${PREFIX}enviar`)) {
            estadoEnvio[sender] = { etapa: "numero" };
            await sock.sendMessage(sender, { text: "📲 Por favor, forneça o número do cliente! (ex: 5511999999999) ou envie o CSV." });
            return;
        }

        if (estadoEnvio[sender]) {
            const estado = estadoEnvio[sender];
            if (m.message.documentMessage) {
                const fileName = m.message.documentMessage.fileName || "contacts.csv";
                const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
                const caminho = path.join(__dirname, "mensagens", fileName);
                fs.writeFileSync(caminho, buffer);
                estado.numeros = extrairNumerosDoCSV(caminho);
                estado.etapa = "mensagem";
                await sock.sendMessage(sender, { text: `📄 CSV com ${estado.numeros.length} números recebidos. Agora envie a mensagem.` });
                return;
            }
            if (estado.etapa === "numero") {
                estado.numeros = [msg.replace(/\D/g, "")]; estado.etapa = "mensagem";
                await sock.sendMessage(sender, { text: "✉️ Agora envie a mensagem de texto." });
                return;
            }
            if (estado.etapa === "mensagem") {
                estado.mensagem = msg; estado.etapa = "midia";
                await sock.sendMessage(sender, { text: "📎 Envie uma imagem/vídeo/documento ou digite **'pular'** para enviar sem mídia." });
                return;
            }
            if (estado.etapa === "midia") {
                if (msg.toLowerCase() === "pular") { await enviarMensagens(sock, estado.numeros, estado.mensagem); }
                else if (m.message.imageMessage || m.message.videoMessage || m.message.documentMessage) {
                    const tipo = m.message.imageMessage ? "image" : m.message.videoMessage ? "video" : "document";
                    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
                    await enviarMensagens(sock, estado.numeros, estado.mensagem, buffer, tipo);
                }
                delete estadoEnvio[sender]; await sock.sendMessage(sender, { text: "Mensagens enviadas com sucesso, meu caro!" });
                return;
            }
        }
        
        // --- Lógica simplificada: Detectar link e gerar oferta ---
        const url_info = await parseUrl(msg.trim());

        if (url_info.itemId && url_info.shopId) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await sock.sendMessage(sender, { text: "Buscando produto e gerando mensagem promocional, aguarde... ⏳" });

            const produto = await obterProdutoPorId(url_info.itemId, url_info.shopId);

            if (!produto) {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, { text: "Produto não encontrado ou erro na API da Shopee. 😔" });
                return;
            }

            const nome = produto.productName || 'Não disponível';
            const link = produto.offerLink || 'Não disponível';
            const imageUrl = produto.imageUrl;
            const precoPromocional = produto.precoMin || 0.0;
            const precoOriginal = produto.precoOriginal || precoPromocional;
            const desconto = produto.priceDiscountRate || 0;

            const mensagemPromocional = await gerarMensagemPromocional(nome);

            const textoResultado = `🔥 *${nome}*
*De* ~~R$ ${precoOriginal.toFixed(2)}~~
💰 *Por R$ ${precoPromocional.toFixed(2)}* 😱
(${desconto}% OFF)

${mensagemPromocional}

🛒 *Compre agora* 👉 ${link}

⚠️ _Promoção sujeita à alteração de preço e estoque do site._
`;
            
            if (imageUrl) {
                await sock.sendMessage(sender, { 
                    image: { url: imageUrl }, 
                    caption: textoResultado, 
                    mimetype: 'image/jpeg' 
                });
            } else {
                await sock.sendMessage(sender, { text: textoResultado });
            }
            
            return;
        }
    });
}

// --- Funções Auxiliares (Envio de Mensagens em Massa) ---
function extrairNumerosDoCSV(caminho) {
    try {
        const linhas = fs.readFileSync(caminho, "utf8").split("\n");
        return linhas.map((linha) => linha.trim().replace(/\D/g, "")).filter((numero) => numero.length >= 11);
    } catch (e) {
        console.error("Error reading CSV:", e); return [];
    }
}
async function enviarMensagens(sock, numeros, mensagem, midia = null, tipo = "text") {
    for (const numero of numeros) {
        const jid = `${numero}@s.whatsapp.net`;
        try {
            if (midia) { await sock.sendMessage(jid, { [tipo]: midia, caption: mensagem }); }
            else { await sock.sendMessage(jid, { text: mensagem }); }
            console.log(`✅ Message sent to ${numero}`);
        } catch (e) {
            console.error(`❌ Error sending to ${numero}:`, e.message);
        }
    }
}

// --- Funções de Sockets.IO para a Interface ---
const isConnected = () => {
    return sock?.user ? true : false;
};

io.on("connection", async (socket) => {
    soket = socket;
    console.log("Novo cliente conectado.");
    if (isConnected()) {
        console.log("Bot já está online. Enviando status de conectado.");
        updateQR("connected");
    } else if (qrState) {
        console.log("QR Code disponível. Enviando para o cliente.");
        updateQR("qr");
    } else {
        console.log("Aguardando QR Code...");
        updateQR("loading");
    }
});

const updateQR = (data) => {
    switch (data) {
        case "qr":
            if (qrState) {
                qrcode.toDataURL(qrState, (err, url) => {
                    soket?.emit("qr", url);
                    soket?.emit("log", "QR recebido, faça a varredura");
                });
            }
            break;
        case "connected":
            soket?.emit("qrstatus", "./assets/check.svg");
            soket?.emit("log", "usuário conectado");
            const { id, name } = sock?.user;
            var userinfo = id + " " + name;
            soket?.emit("user", userinfo);
            break;
        case "loading":
            soket?.emit("qrstatus", "./assets/loader.gif");
            soket?.emit("log", "Carregando...");
            break;
        default:
            break;
    }
};

connectToWhatsApp().catch((err) => console.log("erro inesperado: " + err));
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

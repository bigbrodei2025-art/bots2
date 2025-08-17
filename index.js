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

function normalizarPreco(valor) {
    try {
        const v = parseFloat(valor);
        if (v > 100000) {
            return v / 1000000;
        } else if (v > 100) {
            return v / 100;
        } else {
            return v;
        }
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

    if (desconto > 0 && desconto < 100) {
        precoOriginal = precoPromocional / (1 - desconto / 100);
    }

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

// Rota para o seu `index.html`
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

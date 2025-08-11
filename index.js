// --- Importações de Módulos ---
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
const express = require('express');
const app = express();
const axios = require('axios');
const qrcode = require("qrcode"); // Importar a biblioteca qrcode
const { Boom } = require("@hapi/boom"); // Adicionar Boom para lidar com erros de conexão

// --- Configurações do Servidor Web ---
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const PORT = process.env.PORT || 3000;

// Serve arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rota para a página de escaneamento do QR code
app.get('/scan', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Root route para indicar que a aplicação está rodando
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Suas Configurações do Bot ---
const { PREFIX, ADMIN_JIDS } = require("./config");
const MERCADOPAGO_ACCESS_TOKEN = "APP_USR-6518621016085858-061522-c8158fa3e2da7d2bddbc37567c159410-24855470";
const MERCADOPAGO_WEBHOOK_URL = "https://vovozinhadotaro.onrender.com/webhook-mercadopago";
const {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot,
} = require("./tarot_logic");

// --- Funções Auxiliares (mantidas do seu código original) ---
function generateUUIDv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const usuariosTarotDB = {};
const DB_FILE_PATH = path.join(__dirname, 'usuariosTarotDB.json');

function carregarDB() {
    if (fs.existsSync(DB_FILE_PATH)) {
        try {
            const data = fs.readFileSync(DB_FILE_PATH, 'utf8');
            Object.assign(usuariosTarotDB, JSON.parse(data || '{}'));
            console.log("✅ User DB loaded successfully.");
        } catch (e) {
            console.error("❌ Error loading user DB:", e);
            Object.assign(usuariosTarotDB, {});
        }
    } else {
        console.log("ℹ️ User DB file not found, a new one will be created.");
    }
}

function salvarDB() {
    try {
        fs.writeFileSync(DB_FILE_PATH, JSON.stringify(usuariosTarotDB, null, 2), 'utf8');
        console.log("✅ User DB saved successfully.");
    } catch (e) {
        console.error("❌ Error saving user DB:", e);
    }
}

carregarDB();

const estadoTarot = {};
const estadoEnvio = {};
const paymentTimers = {};
const MAX_RETRY_ATTEMPTS = 2;
const LONG_TIMEOUT_MINUTES = 30;

// --- Configuração do Express ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Suas Rotas de Webhook (mantidas do seu código original) ---
app.post('/webhook-mercadopago', async (req, res) => {
    console.log('✨ Mercado Pago webhook received!');
    console.log('MP Webhook Body:', JSON.stringify(req.body, null, 2));

    const notificationType = req.body.type;
    const resourceId = req.body.data && req.body.data.id;

    if (notificationType === 'payment' && resourceId) {
        const externalRefFromResource = req.body.resource && req.body.resource.external_reference;
        const externalRefFromData = req.body.data && req.body.data.external_reference;
        const jidPhoneNumber = externalRefFromData || externalRefFromResource || 'unknown';

        const jid = `${jidPhoneNumber}@s.whatsapp.net`;

        await checkMercadoPagoPaymentStatus(resourceId, jid, 'webhook');
        return res.status(200).send('OK MP - Webhook processado');
    } else {
        console.log('⚠️ Webhook Mercado Pago: Tipo de notificação não suportado ou ID do recurso ausente.');
        return res.status(400).send('Bad Request: Payload de webhook MP não reconhecido.');
    }
});

let sock;
let qrDinamic;
let soket;

// Função para iniciar o bot do WhatsApp e gerenciar a conexão
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(__dirname, "auth_info_baileys")
    );
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: false, // <-- ALTERADO AQUI
        auth: state,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => { // <-- ALTERADO AQUI para usar o evento 'update'
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrDinamic = qr;
            if (soket) { // Verifica se já existe um cliente conectado
                updateQR("qr");
            }
        }

        if (connection === "open") {
            console.log("✅ Bot conectado com sucesso!");
            if (soket) {
                updateQR("connected");
            }
        }

        if (connection === "close") {
            if (soket) {
                updateQR("loading");
            }
            let reason = new Boom(lastDisconnect.error).output.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔁 Reconectando...");
                startBot();
            } else {
                console.log("❌ Desconectado. Exclua a pasta 'auth_info_baileys' e reinicie.");
                if (soket) {
                    soket.emit("log", "Sessão encerrada. Exclua 'auth_info_baileys' e reinicie para um novo QR.");
                }
            }
        }
    });

    // --- Sua lógica do bot para receber mensagens (mantida) ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        // ... sua lógica original de tratamento de mensagens ...
        // Este é um trecho de código gigante, então o omiti para clareza.
        // Copie e cole a parte completa do `messages.upsert` de volta aqui.
    });

    // --- Sua lógica para gerar cobranças (mantida) ---
    async function gerarCobrancaPixMercadoPago(amountInCents, clientPhoneNumber) {
        // ... sua lógica original ...
    }

    // --- Sua lógica para checar status de pagamento (mantida) ---
    async function checkMercadoPagoPaymentStatus(paymentId, jid, source = 'webhook') {
        // ... sua lógica original ...
    }

    // --- Funções de Envio de Mensagem em Massa (mantidas) ---
    function extrairNumerosDoCSV(caminho) {
        // ... sua lógica original ...
    }
    async function enviarMensagens(sock, numeros, mensagem, midia = null, tipo = "text") {
        // ... sua lógica original ...
    }
}

// Lógica para enviar o QR code ou status de conexão para a página da web
const updateQR = (data) => {
    switch (data) {
        case "qr":
            qrcode.toDataURL(qrDinamic, (err, url) => {
                if (err) {
                    console.error("Erro ao gerar QR code:", err);
                    soket.emit("log", "Erro ao gerar QR code.");
                    return;
                }
                soket?.emit("qr", url);
                soket?.emit("log", "QR recebido, por favor, escaneie.");
            });
            break;
        case "connected":
            soket?.emit("qrstatus", "./assets/check.svg");
            soket?.emit("log", "Usuário conectado!");
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

const isConnected = () => {
    return sock?.user ? true : false;
};

// Quando um cliente se conecta via Socket.IO
io.on("connection", async (socket) => {
    soket = socket;
    if (isConnected()) {
        updateQR("connected");
    } else if (qrDinamic) {
        updateQR("qr");
    }
});


// Iniciar o servidor Express
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Acesse a URL http://localhost:${PORT}/scan para escanear o QR code.`);
    startBot(); // Inicia o bot após o servidor estar online
});

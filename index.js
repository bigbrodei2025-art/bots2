// --- Imports e Configurações Iniciais ---
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
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const axios = require('axios');
const qrcode = require("qrcode");

const { PREFIX, ADMIN_JIDS } = require("./config");

// --- Credenciais do Mercado Pago (ATENÇÃO: Mantenha seguras!) ---
const MERCADOPAGO_ACCESS_TOKEN = "APP_USR-6518621016085858-061522-c8158fa3e2da7d2bddbc37567c159410-24855470";
const MERCADOPAGO_WEBHOOK_URL = "https://vovozinhadotaro.onrender.com/webhook-mercadopago";

// --- Funções Auxiliares (Tarot, UUID) ---
const {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot,
} = require("./tarot_logic");

function generateUUIDv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Persistência de Dados do Usuário ---
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

const PORT = process.env.PORT || 3000;

// Variáveis para gerenciar o estado da conexão e do QR code
let sock;
let qrDinamic;
let soket;

// --- Configuração do Express e Rotas da Interface ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/clear-session', (req, res) => {
    console.log("Solicitação para limpar a sessão recebida da interface.");
    const authPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        io.emit('log', 'Sessão do bot apagada. Inicie uma nova conexão.');
        io.emit('init', { isConnected: false });
        res.json({ message: "Sessão apagada com sucesso." });
    } else {
        res.json({ message: "Nenhuma sessão para apagar." });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Rota do Webhook do Mercado Pago ---
app.post('/webhook-mercadopago', async (req, res) => {
    console.log('✨ Mercado Pago webhook received!');
    console.log('MP Webhook Body:', JSON.stringify(req.body, null, 2));

    const notificationType = req.body.type;
    const resourceId = req.body.data && req.body.data.id;

    if (notificationType === 'payment' && resourceId) {
        const externalRefFromResource = req.body.resource && req.body.resource.external_reference;
        const externalRefFromData = req.body.data && req.body.data.external_reference;
        const jidPhoneNumber = externalRefFromData || externalRefFromData || 'unknown';

        const jid = `${jidPhoneNumber}@s.whatsapp.net`;

        await checkMercadoPagoPaymentStatus(resourceId, jid, 'webhook');
        return res.status(200).send('OK MP - Webhook processado');
    } else {
        console.log('⚠️ Webhook Mercado Pago: Tipo de notificação não suportado ou ID do recurso ausente.');
        return res.status(400).send('Bad Request: Payload de webhook MP não reconhecido.');
    }
});

// --- Função para Gerar Cobrança Pix no Mercado Pago (NOVO LOCAL) ---
async function gerarCobrancaPixMercadoPago(amountInCents, clientPhoneNumber) {
    try {
        const paymentsApiUrl = 'https://api.mercadopago.com/v1/payments';

        if (!MERCADOPAGO_ACCESS_TOKEN) {
            console.error("❌ MERCADOPAGO_ACCESS_TOKEN não está definido!");
            return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };
        }
        if (!MERCADOPAGO_WEBHOOK_URL) {
            console.error("❌ MERCADADOPAGO_WEBHOOK_URL não está definido!");
            return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };
        }

        const idempotencyKey = generateUUIDv4();

        const headers = {
            'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idempotencyKey
        };

        const body = {
            transaction_amount: amountInCents / 100,
            description: "Leitura de Tarô da Vovozinha",
            payment_method_id: "pix",
            external_reference: clientPhoneNumber,
            payer: {
                email: `vovozinha_client_${clientPhoneNumber}@example.com`,
            },
            notification_url: MERCADOPAGO_WEBHOOK_URL
        };

        console.log("Mercado Pago Request Body:", JSON.stringify(body, null, 2));

        const response = await axios.post(paymentsApiUrl, body, { headers: headers });

        if (response.data && response.data.point_of_interaction) {
            const qrCodeData = response.data.point_of_interaction.transaction_data;
            return {
                pixCopiaECola: qrCodeData.qr_code,
                qrCodeBase64: qrCodeData.qr_code_base64,
                paymentId: response.data.id
            };
        }

        console.error("❌ Resposta inesperada da API /payments do Mercado Pago:", JSON.stringify(response.data, null, 2));
        return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };

    } catch (error) {
        console.error("❌ Erro ao criar cobrança Pix com Mercado Pago:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };
    }
}


// --- Função para Consultar Status do Pagamento (NOVO LOCAL) ---
async function checkMercadoPagoPaymentStatus(paymentId, jid, source = 'webhook') {
    if (paymentTimers[jid]) {
        clearTimeout(paymentTimers[jid]); delete paymentTimers[jid]; console.log(`Timer de pagamento limpo para ${jid} (verificação ${source}).`);
    }
    try {
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}` }
        });
        const payment = response.data; const paymentStatus = payment.status; const externalReference = payment.external_reference;
        if (externalReference && `${externalReference}@s.whatsapp.net` === jid) {
            if (paymentStatus === 'approved') {
                usuariosTarotDB[jid].pagamento_confirmado_para_leitura = true; usuariosTarotDB[jid].aguardando_pagamento_para_leitura = false; usuariosTarotDB[jid].last_payment_transaction_id = paymentId; salvarDB();
                await sock.sendMessage(jid, { text: "A Vovozinha sentiu sua energia! ✨ Pagamento confirmado! Diga-me, qual o seu **nome** para a Vovozinha começar? 😊", });
                delete estadoTarot[jid]; estadoTarot[jid] = { etapa: "aguardando_nome" }; return true;
            } else if (paymentStatus === 'pending') { return false; }
            else if (paymentStatus === 'rejected' || paymentStatus === 'cancelled') {
                if (estadoTarot[jid] && estadoTarot[jid].etapa === "aguardando_pagamento_mercadopago") {
                    await sock.sendMessage(jid, { text: "O pagamento **não foi aprovado** ou foi **cancelado**. Tente novamente se desejar a leitura. 😔", });
                    usuariosTarotDB[jid].aguardando_pagamento_para_leitura = false; delete estadoTarot[jid]; salvarDB();
                }
                return false;
            }
        }
        return false;
    } catch (error) {
        console.error(`❌ Erro ao consultar pagamento (${source}) no Mercado Pago:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (estadoTarot[jid] && estadoTarot[jid].etapa === "aguardando_pagamento_mercadopago") {
            await sock.sendMessage(jid, { text: "A Vovozinha sentiu um problema ao verificar seu pagamento. Aguarde ou tente novamente em alguns instantes. 😔", });
        }
        return false;
    }
}


// --- Função de Conexão do Bot de WhatsApp ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(__dirname, "auth_info_baileys")
    );
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        qrDinamic = qr;

        if (qr) {
            updateQR('qr');
        }

        if (connection === 'close') {
            let reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut || reason === 401) {
                 console.log("⚠️ Bot desconectado permanentemente.");
                 updateQR('disconnected');
            } else {
                 console.log("🔁 Reconectando...");
                 updateQR('loading');
                 connectToWhatsApp();
            }
        } else if (connection === 'open') {
             console.log("✅ Bot conectado com sucesso!");
             updateQR('connected');
        }
    });

    // --- Lógica Principal do Processamento de Mensagens do WhatsApp ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        const msg = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const mensagemMinuscula = msg.toLowerCase();
        const hoje = new Date().toISOString().slice(0, 10);

        if (!usuariosTarotDB[sender]) {
            usuariosTarotDB[sender] = { is_admin_granted_access: false };
        }
        if (ADMIN_JIDS.includes(sender) && usuariosTarotDB[sender].is_admin_granted_access !== true) {
            usuariosTarotDB[sender].is_admin_granted_access = true;
            salvarDB();
        }

        const isAdmin = ADMIN_JIDS.includes(sender);
        if (isAdmin) {
            const adminCommand = mensagemMinuscula.trim();
            if (adminCommand.startsWith(`${PREFIX}liberar `)) {
                const targetNumber = adminCommand.substring(PREFIX.length + "liberar ".length).trim();
                const targetJid = `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;
                if (!usuariosTarotDB[targetJid]) { usuariosTarotDB[targetJid] = {}; }
                usuariosTarotDB[targetJid].is_admin_granted_access = true;
                usuariosTarotDB[targetJid].pagamento_confirmado_para_leitura = true;
                salvarDB();
                await sock.sendMessage(sender, { text: `✅ Acesso liberado para ${targetJid}.` });
                await sock.sendMessage(targetJid, { text: `✨ Seu acesso para uma tiragem de Tarô foi liberado. Diga seu **nome** para começarmos! 😊` });
                delete estadoTarot[targetJid];
                estadoTarot[targetJid] = { etapa: "aguardando_nome" };
                return;
            } else if (adminCommand.startsWith(`${PREFIX}revogar `)) {
                const targetNumber = adminCommand.substring(PREFIX.length + "revogar ".length).trim();
                const targetJid = `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;
                if (usuariosTarotDB[targetJid]) {
                    usuariosTarotDB[targetJid].is_admin_granted_access = false;
                    usuariosTarotDB[targetJid].pagamento_confirmado_para_leitura = false;
                    salvarDB();
                    await sock.sendMessage(sender, { text: `❌ Acesso revogado para ${targetJid}.` });
                    await sock.sendMessage(targetJid, { text: `😔 Seu acesso liberado para tiragens foi revogado por um administrador.` });
                    delete estadoTarot[targetJid];
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ Usuário ${targetNumber} não encontrado.` });
                }
                return;
            }
        }

        const comandosCancelar = ["cancelar", "desistir", "nao quero mais", "não quero mais"];
        const isComandoCancelar = comandosCancelar.some(cmd => mensagemMinuscula.includes(cmd));
        if (isComandoCancelar && estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago") {
            if (paymentTimers[sender]) {
                clearTimeout(paymentTimers[sender]); delete paymentTimers[sender];
            }
            usuariosTarotDB[sender].aguardando_pagamento_para_leitura = false;
            salvarDB();
            delete estadoTarot[sender];
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Você cancelou a solicitação de pagamento, meu benzinho. A Vovozinha estará aqui quando precisar de outro conselho! 💖" });
            return;
        }

        const saudacoes = ["oi", "olá", "ola"];
        const isSaudacaoInicio = saudacoes.some(s => mensagemMinuscula.includes(s));
        const isTarotCommandInicio = msg.startsWith(`${PREFIX}tarot`) || mensagemMinuscula.includes("vovó");

        if ((isTarotCommandInicio || isSaudacaoInicio) && !estadoTarot[sender]) {
            if (usuariosTarotDB[sender].is_admin_granted_access === true || usuariosTarotDB[sender].pagamento_confirmado_para_leitura === true) {
                usuariosTarotDB[sender].pagamento_confirmado_para_leitura = true;
                salvarDB();
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "A Vovozinha sente sua energia! Seu acesso já está liberado. Diga-me, qual o seu **nome** para a Vovozinha começar? 😊",
                });
                delete estadoTarot[sender];
                estadoTarot[sender] = { etapa: "aguardando_nome" };
                return;
            }

            if (!usuariosTarotDB[sender].aguardando_pagamento_para_leitura) {
                estadoTarot[sender] = { etapa: "aguardando_confirmacao_1_centavo" };
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "Olá, meu benzinho! Quer fazer uma tiragem de Tarô completa com a Vovozinha por apenas **1 centavo** para sentir a energia das cartas? (Sim/Não) ✨",
                });
                return;
            }
        }

        const comandosPago = ["pago", "já paguei", "ja paguei", "confirmei o pagamento", "paguei"];
        const isComandoPago = comandosPago.some(cmd => mensagemMinuscula.includes(cmd));

        if (isComandoPago && estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago") {
            const paymentIdToVerify = estadoTarot[sender].mercadopago_payment_id;
            if (paymentIdToVerify) {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                await sock.sendMessage(sender, { text: "Vovozinha recebeu! Verificando o pagamento... 🕰️" });
                await checkMercadoPagoPaymentStatus(paymentIdToVerify, sender, 'manual');
            } else {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, { text: "A Vovozinha não encontrou um pagamento recente para verificar, meu benzinho. Por favor, comece com 'vovó' ou '!tarot' para gerar um novo." });
            }
            return;
        }

        if (estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago" && !isComandoPago && !isComandoCancelar) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento pelo Mercado Pago, meu benzinho. Se já pagou, diga 'pago'. Se desistiu, diga 'cancelar'. ✨",
            });
            return;
        }

        // --- Lógica de fluxo de leitura de Tarô (continuação) ---
        if (msg.toLowerCase() === "cancelar" && estadoTarot[sender]) {
            delete estadoTarot[sender];
            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "Leitura de Tarô cancelada, meu benzinho. Volte sempre que precisar do carinho da Vovozinha! 💖",
            });
            return;
        }
        
        if (estadoTarot[sender]) {
            const estado = estadoTarot[sender];
            switch (estado.etapa) {
                case "aguardando_confirmacao_1_centavo":
                    const respostaConfirmacao = msg.trim().toLowerCase();
                    if (respostaConfirmacao === "sim") {
                        const senderPhoneNumber = sender.split('@')[0].replace(/\D/g, '');
                        const valorLeitura = 1;
                        const { pixCopiaECola, qrCodeBase64, paymentId } = await gerarCobrancaPixMercadoPago(valorLeitura, senderPhoneNumber);

                        if (pixCopiaECola && paymentId) {
                            estadoTarot[sender] = {
                                etapa: "aguardando_pagamento_mercadopago",
                                external_reference_gerado: senderPhoneNumber,
                                mercadopago_payment_id: paymentId,
                                retry_count: 0
                            };
                            usuariosTarotDB[sender].aguardando_pagamento_para_leitura = true;
                            usuariosTarotDB[sender].ultima_solicitacao_pagamento_timestamp = new Date().toISOString();
                            usuariosTarotDB[sender].external_reference_atual = estadoTarot[sender].external_reference_gerado;
                            usuariosTarotDB[sender].mercadopago_payment_id = paymentId;
                            salvarDB();

                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                            await sock.sendMessage(sender, { text: `🌜 Perfeito! O valor é de **R$ ${valorLeitura / 100},00**. Faça o pagamento via Pix Copia e Cola para o código abaixo.` });
                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1000));
                            await sock.sendMessage(sender, { text: pixCopiaECola.trim() });
                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1000));
                            if (qrCodeBase64) {
                                const qrBuffer = Buffer.from(qrCodeBase64, 'base64');
                                await sock.sendMessage(sender, { image: qrBuffer, caption: `Ou escaneie o QR Code abaixo para pagar:` });
                            }
                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1000));
                            await sock.sendMessage(sender, { text: `(Este código é válido por um tempo limitado.)` });
                            const scheduleNextCheck = async () => { /* ... lógica de checagem ... */ };
                            paymentTimers[sender] = setTimeout(scheduleNextCheck, 30 * 1000);
                        } else {
                            await sock.sendMessage(sender, { text: "Vovozinha sentiu um bloqueio nas energias! Não consegui gerar o Pix agora. Por favor, tente novamente mais tarde.😔" });
                        }
                    } else if (respostaConfirmacao === "não" || respostaConfirmacao === "nao") {
                        delete estadoTarot[sender];
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "Tudo bem, meu benzinho. A Vovozinha estará aqui quando você precisar de um conselho. Volte sempre! 💖", });
                    } else {
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "A Vovozinha não entendeu. Por favor, diga **'Sim'** ou **'Não'** para confirmar. 🙏", });
                    }
                    break;
                case "aguardando_nome":
                    estado.nome = msg.trim(); estado.etapa = "aguardando_nascimento";
                    usuariosTarotDB[sender].nome = estado.nome; salvarDB();
                    await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, { text: `Que nome lindo, ${estado.nome}! Por favor, me diga sua **data de nascimento** (DDMMYYYY). Ex: 19022001 📅`, });
                    break;
                case "aguardando_nascimento":
                    try {
                        const data_digitada = msg.trim();
                        const data_formatada_para_exibir = formatar_data(data_digitada);
                        const signo_calculado = get_zodiac_sign(data_formatada_para_exibir);
                        estado.nascimento = data_digitada; estado.nascimento_formatado = data_formatada_para_exibir; estado.signo = signo_calculado;
                        estado.etapa = "confirmando_nascimento"; await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 7000));
                        await sock.sendMessage(sender, { text: `A Vovozinha entendeu que você nasceu em **${data_formatada_para_exibir.split("-").reverse().join("/")}** e seu signo é **${signo_calculado}**. Está correto? (Sim/Não) 🤔`, });
                    } catch (e) {
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: `A Vovozinha sentiu algo errado. Por favor, tente novamente no formato DDMMYYYY, meu anjo. 😔`, });
                    }
                    break;
                case "confirmando_nascimento":
                    const resposta_confirmacao = msg.trim().toLowerCase();
                    if (resposta_confirmacao === "sim") {
                        estado.etapa = "aguardando_tema";
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "🕯️ Ótimo! Diga-me, onde seu coração busca conselhos?\n\n1️⃣ **Amor**\n2️⃣ **Trabalho**\n3️⃣ **Dinheiro**\n4️⃣ **Espírito e Alma**\n5️⃣ **Tenho uma pergunta específica**", });
                    } else if (resposta_confirmacao === "não" || resposta_confirmacao === "nao") {
                        estado.etapa = "aguardando_nascimento";
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "Ah, perdão! Por favor, digite sua **data de nascimento** (DDMMYYYY) novamente. Ex: 19022001 📅", });
                    } else {
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "A Vovozinha não entendeu. Por favor, diga **'Sim'** ou **'Não'** para confirmar. 🙏", });
                    }
                    break;
                case "aguardando_tema":
                    const temasOpcoes = { "1": "Amor", "2": "Trabalho", "3": "Dinheiro", "4": "Espírito e alma", "5": "Pergunta Específica", };
                    const temaEscolhidoTexto = temasOpcoes[msg.trim()];
                    if (temaEscolhidoTexto) {
                        estado.tema = temaEscolhidoTexto;
                        if (estado.tema === "Pergunta Específica") {
                            estado.etapa = "aguardando_pergunta";
                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                            await sock.sendMessage(sender, { text: "Conte à Vovozinha... o que te aflige? Escreva sua **pergunta** com carinho: 💬", });
                        } else {
                            estado.etapa = "aguardando_tipo_tiragem";
                            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                            await sock.sendMessage(sender, { text: "✨ Vamos ver quantas cartas você quer que a Vovozinha puxe:\n\n1️⃣ **Apenas uma**\n2️⃣ **Três cartas**\n3️⃣ **Uma tiragem completa**", });
                        }
                    } else {
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "A Vovozinha não entendeu. Por favor, escolha um número de **1 a 5** para o tema. 🙏", });
                    }
                    break;
                case "aguardando_pergunta":
                    estado.pergunta_especifica = msg.trim(); estado.etapa = "aguardando_tipo_tiragem";
                    await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, { text: "✨ Quantas cartas você quer que a Vovozinha puxe:\n\n1️⃣ **Apenas uma**\n2️⃣ **Três cartas**\n3️⃣ **Uma tiragem completa**", });
                    break;
                case "aguardando_tipo_tiragem":
                    const tiposTiragem = { "1": "uma", "2": "tres", "3": "completa", };
                    const tipoTiragemEscolhido = tiposTiragem[msg.trim()];
                    if (tipoTiragemEscolhido) {
                        estado.tipo_tiragem = tipoTiragemEscolhido;
                        await sock.sendPresenceUpdate("composing", sender);
                        const { resultado, cartas_selecionadas, historico_inicial } = await gerar_leitura_tarot(estado.nome, estado.nascimento, estado.tema, estado.tipo_tiragem, estado.pergunta_especifica);
                        await sock.sendPresenceUpdate("paused", sender);
                        estado.cartas = cartas_selecionadas; estado.historico_chat = historico_inicial; estado.etapa = "leitura_concluida";
                        usuariosTarotDB[sender].last_reading_date_completa = new Date().toISOString(); usuariosTarotDB[sender].opt_out_proativo = false; usuariosTarotDB[sender].enviado_lembrete_hoje = false; usuariosTarotDB[sender].aguardando_resposta_lembrete = false;
                        await sock.sendMessage(sender, { text: resultado });
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "💖 Essa foi a sua leitura, meu benzinho. Quando seu coração buscar novas orientações, é só dizer **'vovó'** ou **'!tarot'** novamente. 😊" });
                        if (!usuariosTarotDB[sender].is_admin_granted_access) { usuariosTarotDB[sender].pagamento_confirmado_para_leitura = false; usuariosTarotDB[sender].aguardando_pagamento_para_leitura = false; }
                        delete estadoTarot[sender]; salvarDB();
                    } else {
                        await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, { text: "A Vovozinha não entendeu. Por favor, escolha **'1'**, **'2'**, ou **'3'**. 🙏", });
                    }
                    break;
                default:
                    await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, { text: "A Vovozinha está um pouco confusa. Diga **'vovó'** ou **'!tarot'** para iniciar uma nova leitura. 🤷‍♀️", });
                    delete estadoTarot[sender];
                    break;
            }
            return;
        }

        // --- Lógica de envio de mensagens em massa (separada da lógica do Tarô) ---
        if (msg.startsWith("!ping")) {
            const tempoAtual = new Date(); const status = await sock.getState();
            const responseText = `🏓 PONG! \nConnection Status: ${status}\nCurrent Time: ${tempoAtual.toLocaleString()}`;
            await sock.sendPresenceUpdate("composing", sender); await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: responseText });
            return;
        }
      
        if (msg.startsWith(`${PREFIX}enviar`)) {
            if (estadoTarot[sender]) {
                await sock.sendMessage(sender, { text: "Você já está em uma leitura de Tarô. Digite **'cancelar'** para sair." });
                return;
            }
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

// --- Funções de Sockets.IO para a Interface (nova lógica) ---
const isConnected = () => {
    return sock?.user ? true : false;
};

io.on("connection", async (socket) => {
    soket = socket;
    if (isConnected()) {
        updateQR("connected");
    } else if (qrDinamic) {
        updateQR("qr");
    }
});

const updateQR = (data) => {
    switch (data) {
        case "qr":
            qrcode.toDataURL(qrDinamic, (err, url) => {
                soket?.emit("qr", url);
                soket?.emit("log", "QR recebido, faça a varredura");
            });
            break;
        case "connected":
            soket?.emit("qrstatus", "./assets/check.svg");
            soket?.emit("log", `Conectado como: ${sock.user.name || 'Bot'}`);
            const { id, name } = sock.user;
            var userinfo = id + " " + name;
            soket?.emit("user", userinfo);
            break;
        case "disconnected":
            soket?.emit("qrstatus", "./assets/disconnected.svg");
            soket?.emit("log", "Bot desconectado.");
            break;
        case "loading":
            soket?.emit("qrstatus", "./assets/loader.gif");
            soket?.emit("log", "Carregando...");
            break;
        default:
            break;
    }
};

// --- Inicia o Servidor e o Bot ---
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

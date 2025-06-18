// REMOVIDO: require('dotenv').config({ path: 'agendador.env' }); // Não vamos mais usar o .env para as credenciais principais

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
const axios = require('axios'); // Import axios for HTTP requests

const { PREFIX, ADMIN_JIDS } = require("./config");

// --- ATENÇÃO: CREDENCIAIS HARDCODED! ISSO NÃO É SEGURO PARA PRODUÇÃO ---
// POR FAVOR, AO FAZER O DEPLOY NO RENDER, COLOQUE ESTE TOKEN E A URL DO WEBHOOK
// EM VARIÁVEIS DE AMBIENTE DO RENDER (ex: MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_URL)
// NÃO OS DEIXE DIRETAMENTE NO CÓDIGO!
const MERCADOPAGO_ACCESS_TOKEN = "APP_USR-6518621016085858-061522-c8158fa3e2da7d2bddbc37567c159410-24855470"; // <<< COLE SEU ACCESS TOKEN AQUI!
const MERCADOPAGO_WEBHOOK_URL = "https://vovozinhadotaro.onrender.com/webhook-mercadopago"; // <<< COLE SUA URL DO RENDER AQUI!
// --- FIM DA SEÇÃO DE CREDENCIAIS ---

// As funções do seu tarot_logic.js continuam sendo importadas
const {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot,
} = require("./tarot_logic");

// --- Função Simples para Gerar UUID v4 (para X-Idempotency-Key) ---
// Em um ambiente de produção real, você usaria uma biblioteca como 'uuid'
function generateUUIDv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- User Data Persistence ---
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
const estadoEnvio = {}; // Stores mass message sending state per sender

// --- Objeto para guardar os timers de consulta automática de pagamento ---
const paymentTimers = {};
const MAX_RETRY_ATTEMPTS = 2; // (0, 1, 2 = 3 tentativas no total)
const LONG_TIMEOUT_MINUTES = 30; // Tempo de expiração final

const PORT = process.env.PORT || 3000;

// --- Express App Configuration ---
app.use(express.json()); // Middleware to parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Good practice for webhooks, though MP often sends JSON

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route to indicate the app is running
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html')); // Serve index.html from public
});

// --- Nova Função: Checar Status de Pagamento no Mercado Pago e Liberar Leitura ---
// Adicionado 'source' para diferenciar a origem da chamada (webhook, manual, retry_short, timer_long)
async function checkMercadoPagoPaymentStatus(paymentId, jid, source = 'webhook') {
    // Limpa o timer para este usuário, se existir, pois a verificação será feita agora
    if (paymentTimers[jid]) {
        clearTimeout(paymentTimers[jid]);
        delete paymentTimers[jid];
        console.log(`Timer de pagamento limpo para ${jid} (verificação ${source}).`);
    }

    try {
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
            }
        });

        const payment = response.data;
        const paymentStatus = payment.status;
        const externalReference = payment.external_reference;

        console.log(`Consulta (${source}) - Payment ${paymentId} Status: ${paymentStatus}, External Ref: ${externalReference}`);

        if (externalReference && `${externalReference}@s.whatsapp.net` === jid) {
            if (paymentStatus === 'approved') {
                usuariosTarotDB[jid].pagamento_confirmado_para_leitura = true;
                usuariosTarotDB[jid].aguardando_pagamento_para_leitura = false;
                usuariosTarotDB[jid].last_payment_transaction_id = paymentId;
                salvarDB();

                await sock.sendPresenceUpdate("composing", jid);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(jid, {
                    text: "A Vovozinha sentiu sua energia! ✨ Pagamento confirmado pelo Mercado Pago! Agora, meu benzinho, podemos abrir os caminhos do Tarô. Diga-me, qual o seu **nome** para a Vovozinha começar? 😊",
                });
                delete estadoTarot[jid];
                estadoTarot[jid] = { etapa: "aguardando_nome" };
                console.log(`✅ Leitura liberada via consulta (${source}) para ${jid}`);
                return true; // Pagamento aprovado
            } else if (paymentStatus === 'pending') {
                // Só envia mensagem de pendente se for uma consulta manual.
                // As mensagens das retentativas e do timer longo são gerenciadas fora desta função.
                if (source === 'manual') {
                    await sock.sendPresenceUpdate("composing", jid);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(jid, {
                        text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento, meu benzinho. Ele ainda aparece como **PENDENTE**. Por favor, aguarde mais um pouquinho ou verifique seu aplicativo de pagamento. 🙏",
                    });
                } else if (source === 'timer_long') {
                    // Já é a expiração final, não precisa enviar "pendente" aqui. O timer handle a mensagem de expiração.
                }
                // Para retries curtos (source === 'retry_short' ou webhook), não envia mensagem de "pendente" aqui,
                // a lógica de retentativa ou o fluxo de webhook já lida com o que deve ser enviado.
                return false; // Pagamento pendente
            } else if (paymentStatus === 'rejected' || paymentStatus === 'cancelled') {
                // Se o estado ainda for 'aguardando_pagamento_mercadopago' (evita enviar se já foi cancelado manual)
                if (estadoTarot[jid] && estadoTarot[jid].etapa === "aguardando_pagamento_mercadopago") {
                    await sock.sendPresenceUpdate("composing", jid);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(jid, {
                        text: "A Vovozinha percebeu que o pagamento **não foi aprovado** ou foi **cancelado**. Por favor, tente novamente se desejar a leitura. 😔",
                    });
                    usuariosTarotDB[jid].aguardando_pagamento_para_leitura = false;
                    delete estadoTarot[jid]; // Encerra o fluxo
                    salvarDB();
                }
                return false; // Pagamento não aprovado
            }
        }
        return false; // Transação não corresponde ou status não tratado
    } catch (error) {
        console.error(`❌ Erro ao consultar pagamento (${source}) no Mercado Pago:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Se o estado ainda for 'aguardando_pagamento_mercadopago' (evita enviar se já foi cancelado manual)
        if (estadoTarot[jid] && estadoTarot[jid].etapa === "aguardando_pagamento_mercadopago") {
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(jid, {
                text: "A Vovozinha sentiu um problema ao verificar seu pagamento agora, meu benzinho. Por favor, aguarde ou tente novamente em alguns instantes. 😔",
            });
        }
        return false;
    }
}

// --- Mercado Pago Webhook Route ---
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

        await checkMercadoPagoPaymentStatus(resourceId, jid, 'webhook'); // Passa 'webhook' como source
        return res.status(200).send('OK MP - Webhook processado');
    } else {
        console.log('⚠️ Webhook Mercado Pago: Tipo de notificação não suportado ou ID do recurso ausente.');
        return res.status(400).send('Bad Request: Payload de webhook MP não reconhecido.');
    }
});

let sock;

// --- Function to start the WhatsApp Bot ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(__dirname, "auth_info_baileys")
    );
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") console.log("✅ Bot conectado com sucesso!");
        if (
            connection === "close" &&
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        ) {
            console.log("🔁 Reconectando...");
            startBot();
        }
    });

    console.log('⏰ Agendador de lembretes proativos DESABILITADO, foco na liberação por pagamento! ✨');

    // --- Função para Gerar Cobrança Pix no Mercado Pago ---
    async function gerarCobrancaPixMercadoPago(amountInCents, clientPhoneNumber) {
        try {
            const paymentsApiUrl = 'https://api.mercadopago.com/v1/payments';

            if (!MERCADOPAGO_ACCESS_TOKEN) {
                console.error("❌ MERCADOPAGO_ACCESS_TOKEN não está definido!");
                return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };
            }
            if (!MERCADOPAGO_WEBHOOK_URL) {
                console.error("❌ MERCADOPAGO_WEBHOOK_URL não está definido!");
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
                    paymentId: response.data.id // Retorna o ID do pagamento gerado pelo Mercado Pago
                };
            }

            console.error("❌ Resposta inesperada da API /payments do Mercado Pago:", JSON.stringify(response.data, null, 2));
            return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };

        } catch (error) {
            console.error("❌ Erro ao criar cobrança Pix com Mercado Pago:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
            return { pixCopiaECola: null, qrCodeBase64: null, paymentId: null };
        }
    }

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        const msg =
            m.message.conversation || m.message.extendedTextMessage?.text || "";

        const mensagemMinuscula = msg.toLowerCase();
        const hoje = new Date().toISOString().slice(0, 10);

        // --- Garante que o objeto do usuário existe no início ---
        if (!usuariosTarotDB[sender]) {
            usuariosTarotDB[sender] = { is_admin_granted_access: false };
        }
        // NOVO: Se o remetente é um admin, garante que ele mesmo tenha acesso liberado
        if (ADMIN_JIDS.includes(sender) && usuariosTarotDB[sender].is_admin_granted_access !== true) {
            usuariosTarotDB[sender].is_admin_granted_access = true;
            salvarDB();
        }
        // -----------------------------------------------------

        // --- Lógica de Comandos de ADMIN ---
        const isAdmin = ADMIN_JIDS.includes(sender);
        if (isAdmin) {
            const adminCommand = mensagemMinuscula.trim();
            if (adminCommand.startsWith(`${PREFIX}liberar `)) {
                const targetNumber = adminCommand.substring(PREFIX.length + "liberar ".length).trim();
                const targetJid = `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;

                if (!usuariosTarotDB[targetJid]) {
                    usuariosTarotDB[targetJid] = {};
                }
                usuariosTarotDB[targetJid].is_admin_granted_access = true;
                usuariosTarotDB[targetJid].pagamento_confirmado_para_leitura = true;
                salvarDB();

                await sock.sendMessage(sender, { text: `✅ Acesso liberado para ${targetNumber}. Ele poderá iniciar uma tiragem sem pagar.` });
                await sock.sendMessage(targetJid, { text: `✨ A Vovozinha sentiu uma energia especial! Seu acesso para uma tiragem de Tarô foi liberado por um administrador. Diga seu **nome** para começarmos! 😊` });
                console.log(`Admin ${sender} liberou acesso para ${targetJid}`);
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
                    await sock.sendMessage(sender, { text: `❌ Acesso revogado para ${targetNumber}. Ele precisará pagar por futuras tiragens.` });
                    await sock.sendMessage(targetJid, { text: `😔 A Vovozinha sentiu uma mudança na energia. Seu acesso liberado para tiragens foi revogado por um administrador.` });
                    console.log(`Admin ${sender} revogou acesso para ${targetJid}`);
                    delete estadoTarot[targetJid];
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ Usuário ${targetNumber} não encontrado no banco de dados.` });
                }
                return;
            }
        }

        // --- Lógica para o usuário CANCELAR o processo de pagamento ---
        const comandosCancelar = ["cancelar", "desistir", "nao quero mais", "não quero mais"];
        const isComandoCancelar = comandosCancelar.some(cmd => mensagemMinuscula.includes(cmd));

        if (isComandoCancelar && estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago") {
            if (paymentTimers[sender]) {
                clearTimeout(paymentTimers[sender]);
                delete paymentTimers[sender];
                console.log(`Timer de pagamento cancelado para ${sender}.`);
            }
            usuariosTarotDB[sender].aguardando_pagamento_para_leitura = false;
            salvarDB();

            delete estadoTarot[sender];
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Você cancelou a solicitação de pagamento, meu benzinho. A Vovozinha estará aqui quando precisar de outro conselho! 💖" });
            return;
        }

        // --- Lógica para "Olá/Oi" para iniciar o modo Tarô ou fluxo de Pagamento ---
        const saudacoes = ["oi", "olá", "ola"];
        const isSaudacaoInicio = saudacoes.some(s => mensagemMinuscula.includes(s));

        // Condições para iniciar o fluxo de Tarô/Pagamento
        const isTarotCommandInicio = msg.startsWith(`${PREFIX}tarot`) || mensagemMinuscula.includes("vovó");

        // Se uma saudação ou comando de tarô for recebido, e o bot não estiver em um fluxo de tarô
        if ((isTarotCommandInicio || isSaudacaoInicio) && !estadoTarot[sender]) {
            // PRIMEIRO CHECA: Se tem acesso liberado por admin
            if (usuariosTarotDB[sender].is_admin_granted_access === true) {
                usuariosTarotDB[sender].pagamento_confirmado_para_leitura = true;
                salvarDB();
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "A Vovozinha sente sua energia especial! Seu acesso já está liberado. Diga-me, qual o seu **nome** para a Vovozinha começar? 😊",
                });
                delete estadoTarot[sender];
                estadoTarot[sender] = { etapa: "aguardando_nome" };
                return;
            }

            // SEGUNDO CHECA: Se já pagou (via webhook ou comando 'pago' anterior)
            if (usuariosTarotDB[sender].pagamento_confirmado_para_leitura === true) {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "A Vovozinha já sentiu a sua energia! Seu pagamento já está confirmado. Me diga, qual o seu **nome** para a Vovozinha começar? 😊",
                });
                delete estadoTarot[sender];
                estadoTarot[sender] = { etapa: "aguardando_nome" };
                salvarDB();
                return;
            }

            // TERCEIRO CASO: Se não pagou e não tem acesso admin, propõe o Pix de 1 centavo
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

        // --- Lógica para o usuário dizer "pago" durante a espera pelo pagamento ---
        const comandosPago = ["pago", "já paguei", "ja paguei", "confirmei o pagamento", "paguei"];
        const isComandoPago = comandosPago.some(cmd => mensagemMinuscula.includes(cmd));

        if (isComandoPago && estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago") {
            const paymentIdToVerify = estadoTarot[sender].mercadopago_payment_id;
            if (paymentIdToVerify) {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                await sock.sendMessage(sender, { text: "Vovozinha recebeu! Verificando o pagamento... 🕰️" });
                // A chamada para checkMercadoPagoPaymentStatus já lida com a mensagem de pendente/aprovado/recusado
                await checkMercadoPagoPaymentStatus(paymentIdToVerify, sender, 'manual');
            } else {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, { text: "A Vovozinha não encontrou um pagamento recente para verificar, meu benzinho. Você já gerou o Pix? Por favor, comece com 'vovó' ou '!tarot' para gerar um novo." });
            }
            return;
        }

        // Se o usuário está aguardando pagamento e enviou outra coisa que não é comando de pagamento ou cancelamento
        if (estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago" && !isComandoPago && !isComandoCancelar) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento pelo Mercado Pago, meu benzinho. Já pagou? Se sim, por favor, aguarde mais um pouquinho. Se quiser que eu verifique, diga 'pago' ou 'já paguei'! Se desistiu, diga 'cancelar'. ✨",
            });
            return;
        }

        // --- CONTINUAÇÃO DA LÓGICA DO SEU BOT ---
        if (msg.startsWith("!ping")) {
            const tempoAtual = new Date();
            const status = await sock.getState();
            const responseText = `🏓 PONG! \nConnection Status: ${status}\nCurrent Time: ${tempoAtual.toLocaleString()}`;
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: responseText });
            return;
        }

        if (msg.startsWith(`${PREFIX}enviar`)) {
            if (estadoTarot[sender]) {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "Você já está em uma leitura de Tarô com a Vovozinha. Digite **'cancelar'** para sair da leitura de Tarô.",
                });
                return;
            }
            estadoEnvio[sender] = { etapa: "numero" };
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "📲 Por favor, forneça o número do cliente! (ex: 5511999999999) ou envie o CSV.",
            });
            return;
        }

        if (msg.toLowerCase() === "cancelar" && estadoTarot[sender]) {
            delete estadoTarot[sender];
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "Leitura de Tarô cancelada, meu benzinho. Volte sempre que precisar do carinho da Vovozinha! 💖 Limpeza Energética e Proteção Espiritual Visite https://s.shopee.com.br/BHzHi3dTW",
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
                        const valorLeitura = 1; // 1 centavo

                        const { pixCopiaECola, qrCodeBase64, paymentId } = await gerarCobrancaPixMercadoPago(valorLeitura, senderPhoneNumber);

                        if (pixCopiaECola && paymentId) {
                            estadoTarot[sender] = {
                                etapa: "aguardando_pagamento_mercadopago",
                                external_reference_gerado: senderPhoneNumber,
                                mercadopago_payment_id: paymentId,
                                retry_count: 0 // NOVO: Inicia o contador de retentativas
                            };
                            usuariosTarotDB[sender].aguardando_pagamento_para_leitura = true;
                            usuariosTarotDB[sender].ultima_solicitacao_pagamento_timestamp = new Date().toISOString();
                            usuariosTarotDB[sender].external_reference_atual = estadoTarot[sender].external_reference_gerado;
                            usuariosTarotDB[sender].mercadopago_payment_id = paymentId;
                            salvarDB();


                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1500));

                            // 1. Mensagem inicial com informações do valor
                            await sock.sendMessage(sender, {
                                text: `🌜 Perfeito, meu benzinho! Para a Vovozinha abrir os caminhos do Tarô, a energia precisa fluir. O valor da sua tiragem é de **R$ ${valorLeitura / 100},00**. ✨`
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000));

                            // 2. Mensagem com as instruções para Pix Copia e Cola
                            await sock.sendMessage(sender, {
                                text: `Por favor, faça o pagamento via Pix Copia e Cola para o código abaixo. Assim que for confirmado, a Vovozinha sentirá e te avisará! 💖`
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000));

                            // 3. MENSAGEM SEPARADA APENAS COM O CÓDIGO PIX (COM CRASES NOVAMENTE)
                            await sock.sendMessage(sender, {
                                text: `\`\`\`${pixCopiaECola.trim()}\`\`\``
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000));

                            // 4. NOVA MENSAGEM: Aviso de cópia
                            await sock.sendMessage(sender, {
                                text: `⚠️ Ao copiar, verifique se não há espaços ou aspas (") no início/fim do código. Se houver, remova-os para que o Pix funcione!`
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000));

                            // 5. MENSAGEM ORIGINAL: Apenas o aviso de validade
                            await sock.sendMessage(sender, {
                                text: `(Este código é válido por um tempo limitado.)`
                            });

                            if (qrCodeBase64) {
                                await sock.sendPresenceUpdate("composing", sender);
                                await new Promise((resolve) => setTimeout(resolve, 1500));
                                const qrBuffer = Buffer.from(qrCodeBase64, 'base64');
                                await sock.sendMessage(sender, {
                                    image: qrBuffer,
                                    caption: `Ou escaneie o QR Code abaixo para pagar:`
                                });
                            }

                            // --- NOVO: Configura o timer para a PRIMEIRA consulta automática (30 segundos) ---
                            // Esta é a função que gerencia as 3 tentativas e o timer longo
                            const scheduleNextCheck = async () => {
                                // Se o estado do usuário mudou (pagou, cancelou), não continua
                                if (!estadoTarot[sender] || estadoTarot[sender].etapa !== "aguardando_pagamento_mercadopago") {
                                    console.log(`Scheduler para ${sender} interrompido. Estado mudou.`);
                                    delete paymentTimers[sender];
                                    return;
                                }

                                const currentRetryCount = estadoTarot[sender].retry_count || 0;
                                const paymentIdToVerify = estadoTarot[sender].mercadopago_payment_id;

                                // Se já chegou ao limite de retentativas curtas
                                if (currentRetryCount >= MAX_RETRY_ATTEMPTS) {
                                    console.log(`Tentativas curtas esgotadas para ${sender}. Iniciando timer de ${LONG_TIMEOUT_MINUTES} minutos.`);
                                    await sock.sendPresenceUpdate("composing", sender);
                                    await new Promise((resolve) => setTimeout(resolve, 1000));
                                    await sock.sendMessage(sender, {
                                        text: `Seu Pix está pendente após ${MAX_RETRY_ATTEMPTS + 1} tentativas curtas. A Vovozinha aguardará **${LONG_TIMEOUT_MINUTES} minutos** pela confirmação final. Se o pagamento não for confirmado nesse período, a sessão expirará. ✨`
                                    });

                                    // Configura o timer longo e encerra este scheduler curto
                                    paymentTimers[sender] = setTimeout(async () => {
                                        console.log(`⏰ Sessão de pagamento expirou para ${sender} (${LONG_TIMEOUT_MINUTES} minutos).`);
                                        const finalPaymentApproved = await checkMercadoPagoPaymentStatus(paymentIdToVerify, sender, 'timer_long');

                                        if (!finalPaymentApproved) {
                                            await sock.sendPresenceUpdate("composing", sender);
                                            await new Promise((resolve) => setTimeout(resolve, 1000));
                                            await sock.sendMessage(sender, {
                                                text: "😔 A Vovozinha não conseguiu confirmar seu pagamento após 30 minutos, e a sessão expirou. Por favor, inicie uma nova tiragem se desejar! ✨"
                                            });
                                        }
                                        // Finaliza a sessão independentemente, checkMercadoPagoPaymentStatus já tratou a aprovação
                                        if(usuariosTarotDB[sender]) usuariosTarotDB[sender].aguardando_pagamento_para_leitura = false;
                                        delete estadoTarot[sender];
                                        salvarDB();
                                        delete paymentTimers[sender];
                                    }, LONG_TIMEOUT_MINUTES * 60 * 1000);

                                    return; // Sai da função de scheduler curto
                                }

                                // Se não esgotou as tentativas curtas, continua
                                estadoTarot[sender].retry_count = currentRetryCount + 1; // Incrementa o contador
                                console.log(`⏰ Tentando re-consultar pagamento automaticamente para ${sender} (Tentativa ${estadoTarot[sender].retry_count + 1}/${MAX_RETRY_ATTEMPTS + 1})...`); // +1 para mostrar 1 de 3, 2 de 3

                                await sock.sendPresenceUpdate("composing", sender);
                                await new Promise((resolve) => setTimeout(resolve, 1000));
                                await sock.sendMessage(sender, {
                                    text: `A Vovozinha está fazendo a ${estadoTarot[sender].retry_count + 1}ª checagem automática do seu pagamento... Aguarde um instante! 🔄`
                                });
                                const paymentApproved = await checkMercadoPagoPaymentStatus(paymentIdToVerify, sender, 'retry_short'); // Source 'retry_short'

                                if (!paymentApproved) {
                                    // Se ainda não aprovado, reagenda a próxima tentativa curta
                                    paymentTimers[sender] = setTimeout(scheduleNextCheck, 30 * 1000); // Reagenda a própria função
                                }
                                // Se aprovado, checkMercadoPagoPaymentStatus já lidou com tudo e limpou o timer.
                            };

                            // Inicia a primeira chamada do scheduler (após 30 segundos)
                            paymentTimers[sender] = setTimeout(scheduleNextCheck, 30 * 1000);

                        } else {
                            await sock.sendMessage(sender, { text: "Vovozinha sentiu um bloqueio nas energias! Não consegui gerar o Pix agora. Por favor, tente novamente mais tarde.😔" });
                        }
                    } else if (respostaConfirmacao === "não" || respostaConfirmacao === "nao") {
                        delete estadoTarot[sender];
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "Tudo bem, meu benzinho. A Vovozinha estará aqui quando você precisar de um conselho. Volte sempre! 💖",
                        });
                    } else {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "A Vovozinha não entendeu sua resposta. Por favor, diga **'Sim'** ou **'Não'** para confirmar. 🙏",
                        });
                    }
                    break;

                case "aguardando_nome":
                    estado.nome = msg.trim();
                    estado.etapa = "aguardando_nascimento";

                    usuariosTarotDB[sender].nome = estado.nome;
                    salvarDB();

                    await sock.sendPresenceUpdate("composing", sender);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, {
                        text: `Que nome lindo, ${estado.nome}! Agora, para a Vovozinha sentir melhor sua energia, por favor, me diga sua **data de nascimento** (DDMMYYYY). Ex: 19022001 📅`,
                    });
                    break;

                case "aguardando_nascimento":
                    try {
                        const data_digitada = msg.trim();
                        const data_formatada_para_exibir = formatar_data(data_digitada);
                        const signo_calculado = get_zodiac_sign(data_formatada_para_exibir);

                        estado.nascimento = data_digitada;
                        estado.nascimento_formatado = data_formatada_para_exibir;
                        estado.signo = signo_calculado;

                        estado.etapa = "confirmando_nascimento";
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 7000));
                        await sock.sendMessage(sender, {
                            text: `A Vovozinha entendeu que você nasceu em **${data_formatada_para_exibir
                                .split("-")
                                .reverse()
                                .join("/")}** e seu signo é **${signo_calculado}**. Está correto, meu benzinho? (Sim/Não) 🤔`,
                        });
                    } catch (e) {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: `A Vovozinha sentiu algo errado com essa data: ${e.message} Por favor, tente novamente no formato DDMMYYYY, meu anjo. 😔`,
                        });
                    }
                    break;

                case "confirmando_nascimento":
                    const resposta_confirmacao = msg.trim().toLowerCase();
                    if (resposta_confirmacao === "sim") {
                        estado.etapa = "aguardando_tema";
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "🕯️ Ótimo, está certinho! Diga-me, meu benzinho... onde seu coração busca conselhos?\n\n1️⃣ **Amor**\n2️⃣ **Trabalho**\n3️⃣ **Dinheiro**\n4️⃣ **Espírito e Alma**\n5️⃣ **Tenho uma pergunta específica**",
                        });
                    } else if (resposta_confirmacao === "não" || resposta_confirmacao === "nao") {
                        estado.etapa = "aguardando_nascimento";
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "Ah, perdão, meu anjo! Por favor, digite sua **data de nascimento** (DDMMYYYY) novamente para a Vovozinha. Ex: 19022001 📅",
                        });
                    } else {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "A Vovozinha não entendeu sua resposta. Por favor, diga **'Sim'** ou **'Não'** para confirmar. 🙏",
                        });
                    }
                    break;

                case "aguardando_tema":
                    const temasOpcoes = {
                        "1": "Amor",
                        "2": "Trabalho",
                        "3": "Dinheiro",
                        "4": "Espírito e alma",
                        "5": "Pergunta Específica",
                    };
                    const temaEscolhidoTexto = temasOpcoes[msg.trim()];

                    if (temaEscolhidoTexto) {
                        estado.tema = temaEscolhidoTexto;
                        if (estado.tema === "Pergunta Específica") {
                            estado.etapa = "aguardando_pergunta";
                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1500));
                            await sock.sendMessage(sender, {
                                text: "Conte à Vovozinha... o que te aflige? Escreva sua **pergunta** com carinho:\n(Exemplo: 'Conseguirei aquele emprego?', 'Essa pessoa realmente me ama?') 💬",
                            });
                        } else {
                            estado.etapa = "aguardando_tipo_tiragem";
                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1500));
                            await sock.sendMessage(sender, {
                                text: "✨ Vamos ver quantas cartas você quer que a Vovozinha puxe:\n\n1️⃣ **Apenas uma** – Direto ao ponto, como colher uma flor\n2️⃣ **Três cartas** – Passado, presente e futuro, como o fio da vida\n3️⃣ **Uma tiragem completa** – Para quem quer olhar fundo no poço da alma",
                            });
                        }
                    } else {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "A Vovozinha não entendeu, meu benzinho. Por favor, escolha um número de **1 a 5** para o tema. 🙏",
                        });
                    }
                    break;

                case "aguardando_pergunta":
                    estado.pergunta_especifica = msg.trim();
                    estado.etapa = "aguardando_tipo_tiragem";
                    await sock.sendPresenceUpdate("composing", sender);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, {
                        text: "✨ E para essa pergunta, meu anjo, quantas cartas você quer que a Vovozinha puxe:\n\n1️⃣ **Apenas uma** – Direto ao ponto, como colher uma flor\n2️⃣ **Três cartas** – Passado, presente e futuro, como o fio da vida\n3️⃣ **Uma tiragem completa** – Para quem quer olhar fundo no poço da alma",
                    });
                    break;

                case "aguardando_tipo_tiragem":
                    const tiposTiragem = {
                        "1": "uma",
                        "2": "tres",
                        "3": "completa",
                    };
                    const tipoTiragemEscolhido = tiposTiragem[msg.trim()];

                    if (tipoTiragemEscolhido) {
                        estado.tipo_tiragem = tipoTiragemEscolhido;

                        await sock.sendPresenceUpdate("composing", sender);

                        const { resultado, cartas_selecionadas, historico_inicial } = await gerar_leitura_tarot(
                            estado.nome,
                            estado.nascimento,
                            estado.tema,
                            estado.tipo_tiragem,
                            estado.pergunta_especifica
                        );

                        await sock.sendPresenceUpdate("paused", sender);
                        estado.cartas = cartas_selecionadas;
                        estado.historico_chat = historico_inicial;
                        estado.etapa = "leitura_concluida";
                        usuariosTarotDB[sender].last_reading_date_completa = new Date().toISOString();
                        usuariosTarotDB[sender].opt_out_proativo = false;
                        usuariosTarotDB[sender].enviado_lembrete_hoje = false;
                        usuariosTarotDB[sender].aguardando_resposta_lembrete = false;

                        await sock.sendMessage(sender, { text: resultado });
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));

                        // --- Mensagem de encerramento da leitura e instrução para próxima ---
                        await sock.sendMessage(sender, {
                            text: "💖 Essa foi a sua leitura, meu benzinho. A Vovozinha sente que o universo lhe deu as dicas necessárias para guiar seus passos. ✨\n\nQuando seu coração buscar novas orientações ou quiser outra tiragem completa, é só dizer **'vovó'** ou **'!tarot'** novamente. A Vovozinha estará aqui para te acolher! 😊\n\n_Para Limpeza Energética e Proteção Espiritual, visite: https://s.shopee.com.br/BHzHi3dTW_"
                        });

                        // --- FINALIZA O CICLO DA LEITURA ---
                        if (!usuariosTarotDB[sender].is_admin_granted_access) {
                            usuariosTarotDB[sender].pagamento_confirmado_para_leitura = false;
                            usuariosTarotDB[sender].aguardando_pagamento_para_leitura = false;
                        }
                        delete estadoTarot[sender];
                        salvarDB();
                        // --- FIM DO NOVO ---

                    } else {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "A Vovozinha não entendeu, meu benzinho. Por favor, escolha **'1'** para uma carta, **'2'** para três, ou **'3'** para uma tiragem completa. 🙏",
                        });
                    }
                    break;

                default:
                    await sock.sendPresenceUpdate("composing", sender);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, {
                        text: "A Vovozinha está um pouco confusa, meu benzinho. Parece que o fluxo de leitura foi interrompido ou já foi concluído. Por favor, diga **'vovó'** ou **'!tarot'** para iniciar uma nova leitura. 🤷‍♀️",
                    });
                    delete estadoTarot[sender];
                    break;
            }
            return;
        }

        // Logic for sending mass messages (kept separate from Tarot logic)
        if (estadoEnvio[sender]) {
            const estado = estadoEnvio[sender];

            if (m.message.documentMessage) {
                const fileName = m.message.documentMessage.fileName || "contacts.csv";
                const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
                const caminho = path.join(__dirname, "mensagens", fileName);
                fs.writeFileSync(caminho, buffer);
                estado.numeros = extrairNumerosDoCSV(caminho);
                estado.etapa = "mensagem";
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: `📄 CSV com ${estado.numeros.length} números recebidos. Agora envie a mensagem.`,
                });
                return;
            }

            if (estado.etapa === "numero") {
                estado.numeros = [msg.replace(/\D/g, "")];
                estado.etapa = "mensagem";
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "✉️ Agora envie a mensagem de texto.",
                });
                return;
            }

            if (estado.etapa === "mensagem") {
                estado.mensagem = msg;
                estado.etapa = "midia";
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "📎 Envie uma imagem/vídeo/documento ou digite **'pular'** para enviar sem mídia.",
                });
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
                    const tipo = m.message.imageMessage
                        ? "image"
                        : m.message.videoMessage
                            ? "video"
                            : "document";

                    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });

                    await enviarMensagens(sock, estado.numeros, estado.mensagem, buffer, tipo);
                }

                delete estadoEnvio[sender];
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "Mensagens enviadas com sucesso, meu caro!",
                });
                return;
            }
        }
    });
}

function extrairNumerosDoCSV(caminho) {
    try {
        const linhas = fs.readFileSync(caminho, "utf8").split("\n");
        return linhas
            .map((linha) => linha.trim().replace(/\D/g, ""))
            .filter((numero) => numero.length >= 11);
    } catch (e) {
        console.error("Error reading CSV:", e);
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

            console.log(`✅ Message sent to ${numero}`);
        } catch (e) {
            console.error(`❌ Error sending to ${numero}:`, e.message);
        }
    }
}

// --- Start the Express server and then the bot ---
// This ensures the web server is listening on a port for Render to detect.
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startBot(); // Start the bot after the server is listening
});

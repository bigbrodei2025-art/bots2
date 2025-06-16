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

const { PREFIX } = require("./config"); // Assume PREFIX ainda está em config.js

// --- ATENÇÃO: CREDENCIAIS HARDCODED! ISSO NÃO É SEGURO PARA PRODUÇÃO ---
// Por favor, considere usar variáveis de ambiente (.env) em um ambiente real.
// ESTE É O SEU NOVO ACCESS TOKEN DO MERCADO PAGO:
const MERCADOPAGO_ACCESS_TOKEN = "APP_USR-6518621016085858-061522-c8158fa3e2da7d2bddbc37567c159410-24855470";
const MERCADOPAGO_WEBHOOK_URL = "https://cuddly-space-meme-4jqx5v7j4v94fpj6-3000.app.github.dev/webhook-mercadopago"; // Sua URL do Codespaces
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
        // CORRIGIDO: nome da variável de usuariosTarosDB para usuariosTarotDB
        fs.writeFileSync(DB_FILE_PATH, JSON.stringify(usuariosTarotDB, null, 2), 'utf8'); 
        console.log("✅ User DB saved successfully.");
    } catch (e) {
        console.error("❌ Error saving user DB:", e);
    }
}

carregarDB();

const estadoTarot = {};
const estadoEnvio = {}; // Stores mass message sending state per sender

const PORT = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Good practice for webhooks, though MP often sends JSON

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.send('<h1>Vovozinha Bot: Active and Ready!</h1><p>Access WhatsApp to interact with the bot. This is just a status indicator.</p>');
});

// --- **WEBHOOK DO MERCADO PAGO SIMPLIFICADO PARA TESTE DE CONEXÃO** ---
// Tudo que ele faz é logar e responder 200 OK.
// A lógica real do webhook está TEMPORARIAMENTE comentada para depuração do 401.
app.post('/webhook-mercadopago', async (req, res) => {
    console.log('✨ Webhook do Mercado Pago RECEBIDO (VERSÃO SIMPLIFICADA)!');
    console.log('Corpo da Requisição:', JSON.stringify(req.body, null, 2));
    
    // Responde 200 OK imediatamente para ver se o Mercado Pago aceita a conexão.
    return res.status(200).send('OK'); 
});
// --- **FIM DO WEBHOOK SIMPLIFICADO** ---


let sock; // Declara sock globalmente para ser acessível pelas rotas do webhook

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

            // Verificações de credenciais (já hardcoded, mas a verificação é boa)
            if (!MERCADOPAGO_ACCESS_TOKEN) {
                console.error("❌ MERCADOPAGO_ACCESS_TOKEN não está definido!");
                return { pixCopiaECola: null, qrCodeBase64: null };
            }
            if (!MERCADOPAGO_WEBHOOK_URL) {
                console.error("❌ MERCADOPAGO_WEBHOOK_URL não está definido!");
                return { pixCopiaECola: null, qrCodeBase64: null };
            }

            // Gerar o X-Idempotency-Key
            const idempotencyKey = generateUUIDv4();

            const headers = {
                'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': idempotencyKey // NOVO CABEÇALHO AQUI!
            };

            const body = {
                transaction_amount: amountInCents / 100, // Mercado Pago espera valor em BRL (float), não centavos
                description: "Leitura de Tarô da Vovozinha",
                payment_method_id: "pix",
                external_reference: clientPhoneNumber, // O número de telefone do cliente como referência externa
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
                };
            }

            console.error("❌ Resposta inesperada da API /payments do Mercado Pago:", JSON.stringify(response.data, null, 2));
            return { pixCopiaECola: null, qrCodeBase64: null };

        } catch (error) {
            console.error("❌ Erro ao criar cobrança Pix com Mercado Pago:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
            return { pixCopiaECola: null, qrCodeBase64: null };
        }
    }


    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        const msg =
            m.message.conversation || m.message.extendedTextMessage?.text || "";

        const hoje = new Date().toISOString().slice(0, 10);

        // --- Garante que o objeto do usuário existe no início ---
        if (!usuariosTarotDB[sender]) {
            usuariosTarotDB[sender] = {};
        }
        // -----------------------------------------------------

        // --- Lógica para "Olá/Oi" para iniciar o modo Tarô ou fluxo de Pagamento ---
        const saudacoes = ["oi", "olá", "ola"];
        const mensagemMinuscula = msg.toLowerCase();
        const isSaudacao = saudacoes.some(s => mensagemMinuscula.includes(s));

        // Se uma saudação ou comando de tarô for recebido, e o bot não estiver já em um fluxo de tarô
        if ((msg.startsWith(`${PREFIX}tarot`) || msg.toLowerCase().includes("vovó") || isSaudacao) && !estadoTarot[sender]) {
            // Verifica se o pagamento já está confirmado para este JID (via webhook Mercado Pago)
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

            // Se o pagamento NÃO estiver confirmado, propõe a leitura de 1 centavo
            if (!usuariosTarotDB[sender].aguardando_pagamento_para_leitura) {
                estadoTarot[sender] = { etapa: "aguardando_confirmacao_1_centavo" };
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "Olá, meu benzinho! Quer fazer uma tiragem de Tarô completa com a Vovozinha por apenas **1 centavo** para sentir a energia das cartas? (Sim/Não) ✨",
                });
                return;
            }

            // Se o usuário já estiver aguardando o pagamento e enviar outra mensagem
            if (estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_mercadopago") {
                await sock.sendPresenceUpdate("composing", sender);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await sock.sendMessage(sender, {
                    text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento pelo Mercado Pago, meu benzinho. Já pagou? Se sim, por favor, aguarde mais um pouquinho. Se não, o código Pix está logo acima! ✨",
                });
                return;
            }
        }


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

                        estadoTarot[sender] = {
                            etapa: "aguardando_pagamento_mercadopago",
                            external_reference_gerado: senderPhoneNumber
                        };
                        usuariosTarotDB[sender].aguardando_pagamento_para_leitura = true;
                        usuariosTarotDB[sender].ultima_solicitacao_pagamento_timestamp = new Date().toISOString();
                        usuariosTarotDB[sender].external_reference_atual = estadoTarot[sender].external_reference_gerado;
                        salvarDB();

                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));

                        const { pixCopiaECola, qrCodeBase64 } = await gerarCobrancaPixMercadoPago(valorLeitura, senderPhoneNumber);

                        if (pixCopiaECola) {
                            // 1. Mensagem inicial com informações do valor
                            await sock.sendMessage(sender, {
                                text: `🌜 Perfeito, meu benzinho! Para a Vovozinha abrir os caminhos do Tarô, a energia precisa fluir. O valor da sua tiragem é de **R$ ${valorLeitura / 100},00**. ✨`
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000)); // Pequena pausa

                            // 2. Mensagem com as instruções para Pix Copia e Cola
                            await sock.sendMessage(sender, {
                                text: `Por favor, faça o pagamento via Pix Copia e Cola para o código abaixo. Assim que for confirmado, a Vovozinha sentirá e te avisará! 💖`
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000)); // Pequena pausa

                            // 3. MENSAGEM SEPARADA APENAS COM O CÓDIGO PIX
                            await sock.sendMessage(sender, {
                                text: `\n${pixCopiaECola}\n` // SEM AS CRASES AQUI
                            });

                            await sock.sendPresenceUpdate("composing", sender);
                            await new Promise((resolve) => setTimeout(resolve, 1000)); // Pequena pausa

                            // 4. NOVA MENSAGEM: Apenas o aviso de validade
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
                        } else {
                            await sock.sendMessage(sender, { text: "Vovozinha sentiu um bloqueio nas energias! Não consegui gerar o Pix agora. Por favor, tente novamente mais tarde. 😔" });
                        }
                    } else if (respostaConfirmacao === "não" || respostaConfirmacao === "nao") {
                        delete estadoTarot[sender]; // Reseta o estado do Tarot
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

                case "aguardando_pagamento_mercadopago":
                    await sock.sendPresenceUpdate("composing", sender);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, {
                        text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento pelo Mercado Pago, meu benzinho. Já pagou? Se sim, por favor, aguarde mais um pouquinho. Se não, o código Pix está logo acima! ✨",
                    });
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
                            text: "A Vovozinha não entendeu sua resposta. Por favor, diga **'Sim'** ou **'Não'** para confirmar sua data de nascimento. 🙏",
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
                        salvarDB();

                        await sock.sendMessage(sender, { text: resultado });
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "💖 Essa foi a sua leitura. A Vovozinha sente que o universo te deu as dicas necessárias. Se quiser mais sabedoria das cartas, é só começar uma nova leitura! Limpeza Energética e Proteção Espiritual Visite https://s.shopee.com.br/BHzHi3dTW ✨\n\nSe quiser perguntar mais sobre a leitura de hoje, é só digitar sua pergunta. A Vovozinha está aqui para te acolher! 😊",
                        });
                    } else {
                        await sock.sendPresenceUpdate("composing", sender);
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        await sock.sendMessage(sender, {
                            text: "A Vovozinha não entendeu, meu benzinho. Por favor, escolha **'1'** para uma carta, **'2'** para três, ou **'3'** para uma tiragem completa. 🙏",
                        });
                    }
                    break;

                case "leitura_concluida":
                    await sock.sendPresenceUpdate("composing", sender);
                    const { historico: novoHistorico, resposta: respostaConversa } = await conversar_com_tarot(
                        estado.historico_chat,
                        msg,
                        estado.nome,
                        estado.tema,
                        estado.signo,
                        estado.cartas,
                        estado.pergunta_especifica
                    );
                    estado.historico_chat = novoHistorico;
                    await sock.sendPresenceUpdate("paused", sender);
                    await sock.sendMessage(sender, { text: respostaConversa });
                    break;

                default:
                    await sock.sendPresenceUpdate("composing", sender);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await sock.sendMessage(sender, {
                        text: "A Vovozinha está um pouco confusa, meu benzinho. Parece que a leitura foi interrompida. Por favor, digite **'cancelar'** para reiniciar ou **'vovó'** para tentar uma nova leitura. 🤷‍♀️",
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
                await sock.sendMessage(jid, { text: mensagem }); // CORRIGIDO AQUI (removido jid duplicado)
            }

            console.log(`✅ Message sent to ${numero}`);
        } catch (e) {
            console.error(`❌ Error sending to ${numero}:`, e.message);
        }
    }
}

startBot();
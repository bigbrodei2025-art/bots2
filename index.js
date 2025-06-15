// Add this line to the TOP of your file
require('dotenv').config({ path: 'agendador.env' });

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
// REMOVIDO: const cron = require('node-cron');
const axios = require('axios'); // Import axios for HTTP requests
const xml2js = require('xml2js'); // Import xml2js to parse XML from PagBank

const { PREFIX } = require("./config"); // Ensure 'config' exists and exports PREFIX

const {
  formatar_data,
  get_zodiac_sign,
  gerar_leitura_tarot,
  conversar_com_tarot, // Import conversation function
} = require("./tarot_logic"); // Path changed to tarot_logic.js

// --- PagBank Credentials (ATTENTION: CHANGE TO ENVIRONMENT VARIABLES IN PRODUCTION!) ---
// In production, use: process.env.PAGBANK_API_KEY and process.env.PAGBANK_EMAIL
const PAGBANK_API_KEY = "46A6020658588E6994874FAEEB2EE8E3"; // YOUR UPDATED INTEGRATION KEY HERE!
const PAGBANK_EMAIL = "tiagocarvalho-22@hotmail.com"; // YOUR EMAIL HERE
const PAGBANK_WEBHOOK_URL = "https://vovozinhadotaro.onrender.com/webhook-pagbank"; // YOUR RENDER URL HERE!

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

const PORT = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // For PagSeguro, might need urlencoded too

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('<h1>Vovozinha Bot: Active and Ready!</h1><p>Access WhatsApp to interact with the bot. This is just a status indicator.</p>');
});

// --- PagBank Webhook Route ---
app.post('/webhook-pagbank', async (req, res) => {
    console.log('✨ PagBank webhook received!');
    const notificationCode = req.body.notificationCode; // PagBank usually sends a notification code

    if (!notificationCode) {
        console.warn('⚠️ PagBank Webhook: notificationCode missing in payload.');
        return res.status(400).send('Bad Request: notificationCode is missing.');
    }

    try {
        // Step 1: Query transaction details using the notificationCode
        const response = await axios.get(`https://ws.pagseguro.uol.com.br/v3/transactions/notifications/${notificationCode}?email=${PAGBANK_EMAIL}&token=${PAGBANK_API_KEY}`, {
            headers: { 'Content-Type': 'application/xml;charset=UTF-8' },
            responseType: 'text' // PagBank usually returns XML
        });

        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        const transaction = result.transaction;

        console.log('PagBank Transaction Details:', JSON.stringify(transaction, null, 2));

        // Check transaction status
        // Status 3: Paid/Approved, Status 4: Available (for withdrawal) - Depends on your logic
        if (transaction && (transaction.status === '3' || transaction.status === '4')) {
            const orderId = transaction.reference; // 'reference' is what we use as orderId/client identifier
            const transactionId = transaction.code;

            // Extract JID from the orderId we created (e.g., 5511999999999_TIMESTAMP)
            const [clientPhoneNumber] = orderId.split('_');
            const jid = `${clientPhoneNumber}@s.whatsapp.net`;

            // Ensure the user object exists to avoid errors
            if (!usuariosTarotDB[jid]) {
                usuariosTarotDB[jid] = {};
            }

            // Mark payment as confirmed
            usuariosTarotDB[jid].pagamento_confirmado_para_leitura = true;
            usuariosTarotDB[jid].aguardando_pagamento_para_leitura = false; // Reset waiting flag, if set
            usuariosTarotDB[jid].last_payment_transaction_id = transactionId;
            salvarDB();

            // Release the reading to the user
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(jid, {
                text: "Vovozinha felt your energy! ✨ Payment confirmed by PagBank! Now, my dear, we can open the paths of Tarot. Tell me, what's your **name** so Vovozinha can begin? 😊",
            });
            delete estadoTarot[jid]; // Clear current user state
            estadoTarot[jid] = { etapa: "aguardando_nome" }; // Start the reading flow
            console.log(`✅ Reading released via PagBank webhook for ${jid}`);
        } else {
            console.log(`ℹ️ PagBank Webhook: Transaction ${transaction ? transaction.code : 'N/A'} not approved (Status: ${transaction ? transaction.status : 'N/A'}).`);
        }
    } catch (error) {
        console.error('❌ Error processing PagBank webhook:', error.response ? error.response.data : error.message);
    }

    res.status(200).send('OK'); // ALWAYS respond 200 OK to the webhook
});


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

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") console.log("✅ Bot connected successfully!");
    if (
      connection === "close" &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      console.log("🔁 Reconnecting...");
      startBot();
    }
  });

  // REMOVIDO: Agendador de lembretes proativos e toda a lógica de CRON
  console.log('⏰ Proactive reminder scheduler DISABLED. Payment releases consultation! ✨');


  // --- Function to Generate Pix Payment on PagBank (Returns Pix Copia e Cola) ---
  async function gerarCobrancaPixPagBank(amountInCents, orderReferenceId) {
      try {
          const chargesApiUrl = 'https://api.pagseguro.com/charges'; // Endpoint to create Pix payments in API V4

          const headers = {
              'Authorization': `Bearer ${PAGBANK_API_KEY}`,
              'Content-Type': 'application/json',
              'x-api-version': '4.0' // Check API version in PagBank documentation for your account
          };

          const body = {
              reference_id: orderReferenceId, // Your unique ID for this transaction
              description: "Vovozinha's Tarot Reading - Pix",
              amount: {
                  value: amountInCents,
                  currency: "BRL"
              },
              payment_method: {
                  type: "PIX",
                  installments: 1,
                  capture: true
              },
              notification_urls: [PAGBANK_WEBHOOK_URL], // Your webhook URL
              soft_descriptor: "VOVOZINHA TARO", // Name that appears on statement
              customer: {
                  name: `Vovozinha Client (${orderReferenceId})`, // Name for identification
                  email: "anonymous@example.com", // Standard or collected client email
                  tax_id: "00000000000" // Client's CPF, if collected and validated
              }
          };

          const response = await axios.post(chargesApiUrl, body, { headers: headers });

          if (response.data && response.data.charges && response.data.charges[0]) {
              const charge = response.data.charges[0];
              const pixInfo = charge.payment_method.qr_codes && charge.payment_method.qr_codes[0];

              if (pixInfo && pixInfo.text_code) {
                  return {
                      pixCopiaECola: pixInfo.text_code,
                      qrCodeImageUrl: pixInfo.links ? pixInfo.links.find(link => link.rel === 'QR_CODE_PNG')?.href : null
                  };
              }
          }

          console.error("❌ Unexpected response from PagBank Charges API (Pix):", response.data);
          return { pixCopiaECola: null, qrCodeImageUrl: null };

      } catch (error) {
          console.error("❌ Error generating Pix payment with PagBank:", error.response ? error.response.data : error.message);
          return { pixCopiaECola: null, qrCodeImageUrl: null };
      }
  }


  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const msg =
      m.message.conversation || m.message.extendedTextMessage?.text || "";

    const hoje = new Date().toISOString().slice(0, 10);

    // --- Ensure user object exists at the very beginning ---
    if (!usuariosTarotDB[sender]) {
        usuariosTarotDB[sender] = {};
    }
    // -----------------------------------------------------

    // REMOVIDO: Lógica de Tratamento de Respostas aos Lembretes Proativos (não há mais lembretes)
    if (usuariosTarotDB[sender].aguardando_resposta_lembrete) {
        const usuario = usuariosTarotDB[sender];
        const resposta = msg.trim().toLowerCase();
        
        // This block should ideally not be reached as cron is disabled
        // Kept for robustness in case of legacy states or manual opt-out process.
        if (resposta === "1" || resposta.includes("sim")) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Que bom, meu benzinho! Vamos lá, me diga qual o seu **nome** para a Vovozinha começar? 😊" });
            delete estadoTarot[sender];
            estadoTarot[sender] = { etapa: "aguardando_nome" };
            usuario.aguardando_resposta_lembrete = false;
            salvarDB();
            return;
        } else if (resposta === "2" || resposta.includes("não") || resposta.includes("nao")) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Tudo bem, meu benzinho. Estarei aqui quando precisar. 💖" });
            usuario.aguardando_resposta_lembrete = false;
            salvarDB();
            return;
        } else if (resposta === "3" || resposta.includes("não quero mais receber")) {
            usuario.opt_out_proativo = true;
            usuario.aguardando_resposta_lembrete = false;
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Compreendido, meu benzinho. Não enviarei mais lembretes proativos. Se precisar de mim, me chame com **!tarot** ou **'vovó'**." });
            salvarDB();
            return;
        } else {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, { text: "Vovozinha não entendeu bem, meu benzinho. Para continuar com a consulta digite **'1'**. Para não fazer a consulta hoje **'2'**. Para não receber mais lembretes **'3'**." });
            return;
        }
    }

    // --- Logic for "Hi/Hello" to start Tarot mode or Payment flow ---
    const saudacoes = ["oi", "olá", "ola"];
    const mensagemMinuscula = msg.toLowerCase();
    const isSaudacao = saudacoes.some(s => mensagemMinuscula.includes(s));

    // If a greeting or tarot command is received, and the bot is not already in a tarot flow
    if ((msg.startsWith(`${PREFIX}tarot`) || msg.toLowerCase().includes("vovó") || isSaudacao) && !estadoTarot[sender]) {
      // Check if payment is already confirmed for this JID (via PagBank webhook)
      if (usuariosTarotDB[sender].pagamento_confirmado_para_leitura === true) {
          await sock.sendPresenceUpdate("composing", sender);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await sock.sendMessage(sender, {
              text: "A Vovozinha já sentiu a sua energia! Seu pagamento já está confirmado. Me diga, qual o seu **nome** para a Vovozinha começar? 😊",
          });
          delete estadoTarot[sender]; // Clear any previous state
          estadoTarot[sender] = { etapa: "aguardando_nome" }; // Start the reading flow
          salvarDB();
          return;
      }

      // If payment is not confirmed, initiate payment request
      if (!usuariosTarotDB[sender].aguardando_pagamento_para_leitura) {
          estadoTarot[sender] = {
              etapa: "aguardando_pagamento_pagbank", // New stage to indicate Pix waiting
              order_id_gerado: `${sender.split('@')[0].replace(/\D/g, '')}_${Date.now()}`
          };
          usuariosTarotDB[sender].aguardando_pagamento_para_leitura = true;
          usuariosTarotDB[sender].ultima_solicitacao_pagamento_timestamp = new Date().toISOString();
          usuariosTarotDB[sender].order_id_atual = estadoTarot[sender].order_id_gerado; // Save for webhook match
          salvarDB();

          const valorLeitura = 100; // R$ 1.00 in cents

          await sock.sendPresenceUpdate("composing", sender);
          await new Promise((resolve) => setTimeout(resolve, 1500));

          // Call the function that generates Pix Copia e Cola
          const { pixCopiaECola, qrCodeImageUrl } = await gerarCobrancaPixPagBank(valorLeitura, estadoTarot[sender].order_id_gerado);

          if (pixCopiaECola) {
              await sock.sendMessage(sender, {
                  text: `🌜 Olá, meu benzinho… Para a Vovozinha abrir os caminhos do Tarô para você, a energia precisa fluir. O valor da sua tiragem é de **R$ ${valorLeitura / 100},00**. ✨\n\nFaça o pagamento via Pix Copia e Cola para o código abaixo. Assim que o pagamento for confirmado, a Vovozinha sentirá e te avisará! 💖\n\n\`\`\`${pixCopiaECola}\`\`\`\n\n(Este código é válido por um tempo limitado. Se expirar, comece novamente com 'vovó' ou '!tarot'.)`
              });
              if (qrCodeImageUrl) {
                 await sock.sendPresenceUpdate("composing", sender);
                 await new Promise((resolve) => setTimeout(resolve, 1500));
                 await sock.sendMessage(sender, {
                    image: { url: qrCodeImageUrl },
                    caption: `Ou escaneie o QR Code abaixo para pagar: `
                 });
              }

          } else {
              await sock.sendMessage(sender, { text: "Vovozinha sentiu um bloqueio nas energias! Não consegui gerar o código Pix agora. Por favor, tente novamente mais tarde. 😔" });
          }
          return;
      }

      // If the user is already waiting for PagBank payment and sends another message
      if (estadoTarot[sender] && estadoTarot[sender].etapa === "aguardando_pagamento_pagbank") {
          await sock.sendPresenceUpdate("composing", sender);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await sock.sendMessage(sender, {
              text: "A Vovozinha ainda está aguardando a confirmação do seu pagamento pelo PagBank, meu benzinho. Já pagou? Se sim, aguarde um pouco mais. Se não, o código Pix está logo acima! ✨",
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
          text: "You are already in a Tarot reading with Vovozinha. Type **'cancelar'** to exit the Tarot reading.",
        });
        return;
      }
      estadoEnvio[sender] = { etapa: "numero" };
      await sock.sendPresenceUpdate("composing", sender);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await sock.sendMessage(sender, {
        text: "📲 Please provide the client's number! (e.g., 5511999999999) or send the CSV.",
      });
      return;
    }

    if (msg.toLowerCase() === "cancelar" && estadoTarot[sender]) {
      delete estadoTarot[sender];
      await sock.sendPresenceUpdate("composing", sender);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await sock.sendMessage(sender, {
        text: "Tarot reading canceled, my dear. Come back anytime you need Vovozinha's affection! 💖 Energy Cleansing and Spiritual Protection Visit https://s.shopee.com.br/BHzHi3dTW",
      });
      return;
    }

    if (estadoTarot[sender]) {
      const estado = estadoTarot[sender];

      switch (estado.etapa) {
        case "aguardando_pagamento_pagbank":
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
                text: "Vovozinha is still waiting for your payment confirmation from PagBank, my dear. Have you paid? If so, please wait a little longer. If not, the Pix code is right above! ✨",
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
            text: `What a beautiful name, ${estado.nome}! Now, for Vovozinha to better feel your energy, please tell me your **date of birth** (DDMMYYYY). Ex: 19022001 📅`,
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
              text: `Vovozinha understood that you were born on **${data_formatada_para_exibir
                .split("-")
                .reverse()
                .join("/")}** and your sign is **${signo_calculado}**. Is that correct, my dear? (Yes/No) 🤔`,
            });
          } catch (e) {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: `Vovozinha feels something is wrong with that date: ${e.message} Please try again with the DDMMYYYY format, my angel. 😔`,
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
              text: "🕯️ Great, it's correct! Tell me, my dear... where does your heart seek advice?\n\n1️⃣ **Love**\n2️⃣ **Work**\n3️⃣ **Money**\n4️⃣ **Spirit and Soul**\n5️⃣ **I have a specific question**",
            });
          } else if (resposta_confirmacao === "não" || resposta_confirmacao === "nao") {
            estado.etapa = "aguardando_nascimento";
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: "Oh, pardon me, my angel! Please type your **date of birth** (DDMMYYYY) again for Vovozinha. Ex: 19022001 📅",
            });
          } else {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: "Vovozinha didn't understand your answer. Please say **'Sim'** or **'Não'** to confirm your date of birth. 🙏",
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
                text: "Tell Vovozinha... what worries you? Write your **question** with care:\n(Example: 'Will I get that job?', 'Does this person really love me?') 💬",
              });
            } else {
              estado.etapa = "aguardando_tipo_tiragem";
              await sock.sendPresenceUpdate("composing", sender);
              await new Promise((resolve) => setTimeout(resolve, 1500));
              await sock.sendMessage(sender, {
                text: "✨ Let's see how many cards you want Vovozinha to pull:\n\n1️⃣ **Just one** – Straight to the point, like picking a flower\n2️⃣ **Three cards** – Past, present, and future, like the thread of life\n3️⃣ **A full spread** – For those who want to look deep into the well of the soul",
              });
            }
          } else {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: "Vovozinha didn't understand, my dear. Please choose a number from **1 to 5** for the theme. 🙏",
            });
          }
          break;

        case "aguardando_pergunta":
          estado.pergunta_especifica = msg.trim();
          estado.etapa = "aguardando_tipo_tiragem";
          await sock.sendPresenceUpdate("composing", sender);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await sock.sendMessage(sender, {
            text: "✨ And for that question, my angel, how many cards do you want Vovozinha to pull:\n\n1️⃣ **Just one** – Straight to the point, like picking a flower\n2️⃣ **Three cards** – Past, present, and future, like the thread of life\n3️⃣ **A full spread** – For those who want to look deep into the well of the soul",
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

            await sock.sendPresenceUpdate("paused", sender); // Pause typing before sending long response

            estado.cartas = cartas_selecionadas;
            estado.historico_chat = historico_inicial; // Store initial reading history
            estado.etapa = "leitura_concluida";
            usuariosTarotDB[sender].last_reading_date_completa = new Date().toISOString(); // For last reading record only
            usuariosTarotDB[sender].opt_out_proativo = false; // Keep if you want to reactivate proactive messages later
            usuariosTarotDB[sender].enviado_lembrete_hoje = false; // Keep if you want to reactivate proactive messages later
            usuariosTarotDB[sender].aguardando_resposta_lembrete = false; // Keep if you want to reactivate proactive messages later
            salvarDB();

            await sock.sendMessage(sender, { text: resultado });
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: "💖 That was your reading. Vovozinha feels the universe has given you the necessary tips. If you want more wisdom from the cards, just start a new reading! Energy Cleansing and Spiritual Protection Visit https://s.shopee.com.br/BHzHi3dTW ✨\n\nIf you want to ask more about today's reading, just type your question. Vovozinha is here to welcome you! 😊",
            });
          } else {
            await sock.sendPresenceUpdate("composing", sender);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await sock.sendMessage(sender, {
              text: "Vovozinha didn't understand, my dear. Please choose **'1'** for one card, **'2'** for three, or **'3'** for a full spread. 🙏",
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
            text: "Vovozinha is a little confused, my dear. It seems the reading was interrupted. Please type **'cancelar'** to restart or **'vovó'** to try a new reading. 🤷‍♀️",
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
          text: `📄 CSV with ${estado.numeros.length} numbers received. Now send the message.`,
        });
        return;
      }

      if (estado.etapa === "numero") {
        estado.numeros = [msg.replace(/\D/g, "")];
        estado.etapa = "mensagem";
        await sock.sendPresenceUpdate("composing", sender);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await sock.sendMessage(sender, {
          text: "✉️ Now send the text message.",
        });
        return;
      }

      if (estado.etapa === "mensagem") {
        estado.mensagem = msg;
        estado.etapa = "midia";
        await sock.sendPresenceUpdate("composing", sender);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await sock.sendMessage(sender, {
          text: "📎 Send an image/video/document or type **'pular'** to send without media.",
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
          text: "Messages sent successfully, dear!",
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

startBot();

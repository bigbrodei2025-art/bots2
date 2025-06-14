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

const { PREFIX } = require("./config");

const {
  formatar_data,
  get_zodiac_sign,
  gerar_leitura_tarot,
} = require("./tarot_logic");

const estadoTarot = {}; // Armazena o estado do Tarot por remetente
const estadoEnvio = {}; // Armazena o estado do envio de mensagens em massa por remetente

// --- INÍCIO DO CÓDIGO PARA SERVIR O SITE HTML E MANTER A PORTA ATIVA NO RENDER ---
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('<h1>Bot da Vovozinha: Ativo e Prontíssimo!</h1><p>Acesse o WhatsApp para interagir com o bot. Este é apenas um indicador de status.</p>');
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP iniciado na porta ${PORT}`);
});
// --- FIM DO CÓDIGO PARA SERVIR O SITE HTML ---

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
    if (connection === "open") console.log("✅ Bot conectado com sucesso!");
    if (
      connection === "close" &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      console.log("🔁 Reconectando...");
      startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const msg =
      m.message.conversation || m.message.extendedTextMessage?.text || "";

    const hoje = new Date().toISOString().slice(0, 10); // Obtém a data atual (YYYY-MM-DD)

    // --- Lógica ADICIONADA: Resetar o estado do Tarot na virada do dia ---
    // Isso garante que o bot "esqueça" a leitura do dia anterior para o usuário
    // e responda de forma apropriada a novas mensagens como "oi".
    if (estadoTarot[sender] && estadoTarot[sender].last_reading_date && estadoTarot[sender].last_reading_date !== hoje) {
        console.log(`[DEBUG] Resetando estado do Tarot para ${sender}. Última leitura: ${estadoTarot[sender].last_reading_date}, Hoje: ${hoje}`);
        delete estadoTarot[sender]; // Remove o estado salvo do dia anterior
    }
    // --- FIM DA LÓGICA ADICIONADA ---

    // --- Comandos Gerais (se não estiver no fluxo do Tarot) ---
    // A condição `!estadoTarot[sender]` agora funciona corretamente após o reset diário
    if (msg.toLowerCase().includes("oi") && !estadoTarot[sender]) {
      const audioPath = path.join(
        __dirname,
        "audios_vovozinha",
        "saudacao_vovozinha.mp3"
      );
      if (fs.existsSync(audioPath)) {
        await sock.sendPresenceUpdate("recording", sender);
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await sock.sendMessage(sender, {
          audio: { url: audioPath },
          mimetype: "audio/mp3",
          fileName: "saudacao_vovozinha.mp3",
        });
        await sock.sendPresenceUpdate("paused", sender);
      }
      await sock.sendMessage(sender, {
        text: "Olá, meu benzinho! Para entrar no modo tarô da vovozinha escreva **!tarot** ou **'vovó'**. 🌙",
      });
      return;
    }

    if (msg.startsWith("!ping")) {
      const tempoAtual = new Date();
      const status = await sock.getState();
      const responseText = `🏓 PONG! \nStatus da conexão: ${status}\nHora atual: ${tempoAtual.toLocaleString()}`;

      await sock.sendMessage(sender, { text: responseText });
      return;
    }

    // --- Comando para Iniciar Envio de Mensagens em Massa ---
    if (msg.startsWith(`${PREFIX}enviar`)) {
      if (estadoTarot[sender]) {
        await sock.sendMessage(sender, {
          text: "Você já está em uma leitura de Tarot com a Vovozinha. Digite **'cancelar'** para sair da leitura de Tarot.",
        });
        return;
      }
      estadoEnvio[sender] = { etapa: "numero" };
      await sock.sendMessage(sender, {
        text: "📲 Informe o número do cliente por favor! (ex: 5511999999999) ou envie o CSV.",
      });
      return;
    }

    // --- Comando para Iniciar a Leitura do Tarot (Etapa 1: Saudação) ---
    // Este bloco agora pode assumir que o estado já foi limpo no início do dia,
    // ou que é a primeira vez que o usuário interage.
    if (msg.startsWith(`${PREFIX}tarot`) || msg.toLowerCase().includes("vovó")) {
      // A verificação `estadoTarot[sender].last_reading_date === hoje` continua aqui
      // para impedir múltiplas tiragens no MESMO dia.
      if (estadoTarot[sender] && estadoTarot[sender].last_reading_date === hoje) {
        const audioLeituraFeitaPath = path.join(
          __dirname,
          "audios_vovozinha",
          "leitura_ja_feita.mp3"
        );
        if (fs.existsSync(audioLeituraFeitaPath)) {
          await sock.sendPresenceUpdate("recording", sender);
          await new Promise((resolve) => setTimeout(resolve, 7000));
          await sock.sendMessage(sender, {
            audio: { url: audioLeituraFeitaPath },
            mimetype: "audio/mp3",
            fileName: "leitura_ja_feita.mp3",
          });
          await sock.sendPresenceUpdate("paused", sender);
        }
        await sock.sendMessage(sender, {
          text: "Vovozinha já fez uma leitura para você hoje, meu benzinho. Volte amanhã para uma nova tiragem e um novo conselho. 🌙 Tenha um dia abençoado! Limpeza Energética e Proteção Espiritual Visite https://s.shopee.com.br/BHzHi3dTW ✨",
        });
        return;
      }

      // Se já estiver no fluxo (mas não em encerramento/nova tiragem)
      if (estadoTarot[sender] && estadoTarot[sender].etapa !== "leitura_concluida") {
        await sock.sendMessage(sender, {
          text: "Vovozinha já está te atendendo no Tarot, meu benzinho! Digite **'cancelar'** se quiser parar.",
        });
        return;
      }

      // Inicia ou reinicia o estado para o Tarot
      estadoTarot[sender] = {
        etapa: "saudacao",
        nome: "",
        nascimento: "",
        nascimento_formatado: "",
        tema: "",
        tipo_tiragem: "",
        pergunta_especifica: "",
        signo: "",
        cartas: [],
        last_reading_date: "", // Será preenchido após a conclusão da leitura
      };

      const audioSaudacaoPath = path.join(
        __dirname,
        "audios_vovozinha",
        "saudacao_vovozinha.mp3"
      );
      if (fs.existsSync(audioSaudacaoPath)) {
        await sock.sendPresenceUpdate("recording", sender);
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await sock.sendMessage(sender, {
          audio: { url: audioSaudacaoPath },
          mimetype: "audio/mp3",
          fileName: "saudacao_vovozinha.mp3",
        });
        await sock.sendPresenceUpdate("paused", sender);
      }
      await sock.sendMessage(sender, {
        text: "🌜 Olá, meu benzinho… Eu sou a **Vovozinha do Tarô** 🌿\n\nCarrego muitos anos nas costas… e muitos mistérios nas cartas.\n\nQuer que a vovó dê uma espiadinha no seu destino?\n\n1️⃣ **Sim, quero uma tiragem**\n2️⃣ **Não agora, vovó**",
      });
      return;
    }

    // --- Comando para Cancelar o Fluxo do Tarot ---
    if (msg.toLowerCase() === "cancelar" && estadoTarot[sender]) {
      delete estadoTarot[sender];
      const audioCancelamentoPath = path.join(
        __dirname,
        "audios_vovozinha",
        "tarot_cancelado.mp3"
      );
      if (fs.existsSync(audioCancelamentoPath)) {
        await sock.sendPresenceUpdate("recording", sender);
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await sock.sendMessage(sender, {
          audio: { url: audioCancelamentoPath },
          mimetype: "audio/mp3",
          fileName: "tarot_cancelado.mp3",
        });
        await sock.sendPresenceUpdate("paused", sender);
      }
      await sock.sendMessage(sender, {
        text: "Leitura de Tarot cancelada, meu benzinho. Volte sempre que precisar de um carinho da Vovó! 💖 Limpeza Energética e Proteção Espiritual Visite https://s.shopee.com.br/BHzHi3dTW",
      });
      return;
    }

    // --- Processamento das Etapas do Tarot ---
    if (estadoTarot[sender]) {
      const estado = estadoTarot[sender];

      switch (estado.etapa) {
        case "saudacao":
          if (msg.trim() === "1") {
            estado.etapa = "aguardando_nome";
            const audioPedeNomePath = path.join(
              __dirname,
              "audios_vovozinha",
              "pede_nome.mp3"
            );
            if (fs.existsSync(audioPedeNomePath)) {
              await sock.sendPresenceUpdate("recording", sender);
              await new Promise((resolve) => setTimeout(resolve, 7000));
              await sock.sendMessage(sender, {
                audio: { url: audioPedeNomePath },
                mimetype: "audio/mp3",
                fileName: "pede_nome.mp3",
              });
              await sock.sendPresenceUpdate("paused", sender);
            }
            await sock.sendMessage(sender, {
              text: "Ah, que bom! Me diga, meu benzinho, qual o seu **nome** para a Vovozinha começar? 😊",
            });
          } else if (msg.trim() === "2") {
            await sock.sendMessage(sender, {
              text: "Tudo bem, meu benzinho. Quando precisar, a Vovozinha estará aqui. Volte sempre! 💖",
            });
            delete estadoTarot[sender];
          } else {
            await sock.sendMessage(sender, {
              text: "Vovozinha não entendeu, meu benzinho. Por favor, diga **'1'** para iniciar ou **'2'** para depois. 🙏",
            });
          }
          break;

        case "aguardando_nome":
          estado.nome = msg.trim();
          estado.etapa = "aguardando_nascimento";
          const audioPedeNascimentoPath = path.join(
            __dirname,
            "audios_vovozinha",
            "pede_data_nascimento.mp3"
          );
          if (fs.existsSync(audioPedeNascimentoPath)) {
            await sock.sendPresenceUpdate("recording", sender);
            await new Promise((resolve) => setTimeout(resolve, 7000));
            await sock.sendMessage(sender, {
              audio: { url: audioPedeNascimentoPath },
              mimetype: "audio/mp3",
              fileName: "pede_data_nascimento.mp3",
            });
            await sock.sendPresenceUpdate("paused", sender);
          }
          await sock.sendMessage(sender, {
            text: `Que nome lindo, ${estado.nome}! Agora, para a vovó sentir melhor sua energia, me diga sua **data de nascimento** (DDMMYYYY), por favor. Ex: 19022001 📅`,
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
            const audioConfirmaDataPath = path.join(
              __dirname,
              "audios_vovozinha",
              "confirma_data.mp3"
            );
            if (fs.existsSync(audioConfirmaDataPath)) {
              await sock.sendPresenceUpdate("recording", sender);
              await new Promise((resolve) => setTimeout(resolve, 7000));
              await sock.sendMessage(sender, {
                audio: { url: audioConfirmaDataPath },
                mimetype: "audio/mp3",
                fileName: "confirma_data.mp3",
              });
              await sock.sendPresenceUpdate("paused", sender);
            }
            await sock.sendMessage(sender, {
              text: `Vovozinha entendeu que você nasceu em **${data_formatada_para_exibir
                .split("-")
                .reverse()
                .join("/")}** e seu signo é **${signo_calculado}**. Está certinho, meu benzinho? (Sim/Não) 🤔`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: `Vovozinha sente que algo não está certo com essa data: ${e.message} Tente novamente com o formato DDMMYYYY, meu anjo. 😔`,
            });
          }
          break;

        case "confirmando_nascimento":
          const resposta_confirmacao = msg.trim().toLowerCase();
          if (resposta_confirmacao === "sim") {
            estado.etapa = "aguardando_tema";
            const audioPedeTemaPath = path.join(
              __dirname,
              "audios_vovozinha",
              "pede_tema.mp3"
            );
            if (fs.existsSync(audioPedeTemaPath)) {
              await sock.sendPresenceUpdate("recording", sender);
              await new Promise((resolve) => setTimeout(resolve, 7000));
              await sock.sendMessage(sender, {
                audio: { url: audioPedeTemaPath },
                mimetype: "audio/mp3",
                fileName: "pede_tema.mp3",
              });
              await sock.sendPresenceUpdate("paused", sender);
            }
            await sock.sendMessage(sender, {
              text: "🕯️ Que bom que está certinho! Me diga, benzinho… onde anda o seu coração querendo um conselho?\n\n1️⃣ **Amor**\n2️⃣ **Trabalho**\n3️⃣ **Dinheirinhos**\n4️⃣ **Espírito e alma**\n5️⃣ **Tenho uma pergunta específica**",
            });
          } else if (resposta_confirmacao === "não" || resposta_confirmacao === "nao") {
            estado.etapa = "aguardando_nascimento";
            await sock.sendMessage(sender, {
              text: "Oh, perdão, meu anjo! Por favor, digite sua **data de nascimento** (DDMMYYYY) novamente para a Vovozinha. Ex: 19022001 📅",
            });
          } else {
            await sock.sendMessage(sender, {
              text: "Vovozinha não entendeu sua resposta. Por favor, diga **'Sim'** ou **'Não'** para confirmar sua data de nascimento. 🙏",
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
              await sock.sendMessage(sender, {
                text: "Diga pra vovó… o que te preocupa? Escreva sua **pergunta** com carinho:\n(Exemplo: “Vou conseguir aquele emprego?”, “Essa pessoa me ama mesmo?”) 💬",
              });
            } else {
              estado.etapa = "aguardando_tipo_tiragem";
              const audioPedeTipoTiragemPath = path.join(
                __dirname,
                "audios_vovozinha",
                "pede_tipo_tiragem.mp3"
              );
              if (fs.existsSync(audioPedeTipoTiragemPath)) {
                await sock.sendPresenceUpdate("recording", sender);
                await new Promise((resolve) => setTimeout(resolve, 7000));
                await sock.sendMessage(sender, {
                  audio: { url: audioPedeTipoTiragemPath },
                  mimetype: "audio/mp3",
                  fileName: "pede_tipo_tiragem.mp3",
                });
                await sock.sendPresenceUpdate("paused", sender);
              }
              await sock.sendMessage(sender, {
                text: "✨ Vamos ver quantas cartinhas você quer que a vovó puxe:\n\n1️⃣ **Uma só** – Direto ao ponto, como colher uma flor\n2️⃣ **Três cartas** – Passado, presente e futuro, como o fio da vida\n3️⃣ **Uma tiragem completa** – Pra quem quer ver fundo no poço da alma",
              });
            }
          } else {
            await sock.sendMessage(sender, {
              text: "Vovozinha não entendeu, meu benzinho. Por favor, escolha um número de **1 a 5** para o tema. 🙏",
            });
          }
          break;

        case "aguardando_pergunta":
          estado.pergunta_especifica = msg.trim();
          estado.etapa = "aguardando_tipo_tiragem";
          const audioPedeTipoTiragemPerguntaPath = path.join(
            __dirname,
            "audios_vovozinha",
            "pede_tipo_tiragem.mp3"
          );
          if (fs.existsSync(audioPedeTipoTiragemPerguntaPath)) {
            await sock.sendPresenceUpdate("recording", sender);
            await new Promise((resolve) => setTimeout(resolve, 7000));
            await sock.sendMessage(sender, {
              audio: { url: audioPedeTipoTiragemPerguntaPath },
              mimetype: "audio/mp3",
              fileName: "pede_tipo_tiragem.mp3",
            });
            await sock.sendPresenceUpdate("paused", sender);
          }
          await sock.sendMessage(sender, {
            text: "✨ E para essa pergunta, meu anjo, quantas cartinhas você quer que a vovó puxe:\n\n1️⃣ **Uma só** – Direto ao ponto, como colher uma flor\n2️⃣ **Três cartas** – Passado, presente e futuro, como o fio da vida\n3️⃣ **Uma tiragem completa** – Pra quem quer ver fundo no poço da alma",
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

            const { resultado, cartas_selecionadas } = await gerar_leitura_tarot(
              estado.nome,
              estado.nascimento,
              estado.tema,
              estado.tipo_tiragem,
              estado.pergunta_especifica
            );

            await sock.sendPresenceUpdate("paused", sender);

            estado.cartas = cartas_selecionadas;
            estado.etapa = "leitura_concluida";
            // A data da última leitura é salva aqui, após a conclusão
            estado.last_reading_date = hoje; // Usa a variável 'hoje' calculada no início

            await sock.sendMessage(sender, { text: resultado });
            const audioDespedidaDiariaPath = path.join(
              __dirname,
              "audios_vovozinha",
              "despedida_diaria.mp3"
            );
            if (fs.existsSync(audioDespedidaDiariaPath)) {
              await sock.sendPresenceUpdate("recording", sender);
              await new Promise((resolve) => setTimeout(resolve, 7000));
              await sock.sendMessage(sender, {
                audio: { url: audioDespedidaDiariaPath },
                mimetype: "audio/mp3",
                fileName: "despedida_diaria.mp3",
              });
              await sock.sendPresenceUpdate("paused", sender);
            }
            await sock.sendMessage(sender, {
              text: "💖 Essa foi a sua tiragem de hoje, meu benzinho. A Vovozinha sente que o universo já te deu as dicas necessárias para o dia. Volte amanhã para uma nova tiragem! Limpeza Energética e Proteção Espiritual Visite https://s.shopee.com.br/BHzHi3dTW ✨",
            });
          } else {
            await sock.sendMessage(sender, {
              text: "Vovozinha não entendeu, meu benzinho. Por favor, escolha **'1'** para uma carta, **'2'** para três, ou **'3'** para uma tiragem completa. 🙏",
            });
          }
          break;

        case "leitura_concluida":
          // Este caso só será atingido se o estado NÃO foi resetado na virada do dia
          // (ou seja, se a mensagem foi no MESMO dia da leitura).
          const audioLeituraConcluidaPath = path.join(
            __dirname,
            "audios_vovozinha",
            "leitura_ja_feita.mp3"
          );
          if (fs.existsSync(audioLeituraConcluidaPath)) {
            await sock.sendPresenceUpdate("recording", sender);
            await new Promise((resolve) => setTimeout(resolve, 7000));
            await sock.sendMessage(sender, {
              audio: { url: audioLeituraConcluidaPath },
              mimetype: "audio/mp3",
              fileName: "leitura_ja_feita.mp3",
            });
            await sock.sendPresenceUpdate("paused", sender);
          }
          await sock.sendMessage(sender, {
            text: "Ah, meu benzinho, a leitura de hoje já foi feita! A Vovozinha já te deu os conselhos do dia. Volte amanhã para mais sabedoria das cartas. 🌙",
          });
          break;

        default:
          await sock.sendMessage(sender, {
            text: "Vovozinha está um pouco confusa, meu benzinho. Parece que a leitura foi interrompida. Por favor, digite **'cancelar'** para recomeçar ou **'vovó'** para tentar uma nova leitura (se for outro dia). 🤷‍♀️",
          });
          delete estadoTarot[sender];
          break;
      }
      return;
    }

    // --- Processamento do Estado de Envio de Mensagens em Massa (Se o bot não estiver no fluxo de Tarot) ---
    if (estadoEnvio[sender]) {
      const estado = estadoEnvio[sender];

      if (m.message.documentMessage) {
        const fileName = m.message.documentMessage.fileName || "contatos.csv";
        const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: P() });
        const caminho = path.join(__dirname, "mensagens", fileName);
        fs.writeFileSync(caminho, buffer);
        estado.numeros = extrairNumerosDoCSV(caminho);
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, {
          text: `📄 CSV com ${estado.numeros.length} números recebido. Agora envie a mensagem.`,
        });
        return;
      }

      if (estado.etapa === "numero") {
        estado.numeros = [msg.replace(/\D/g, "")];
        estado.etapa = "mensagem";
        await sock.sendMessage(sender, {
          text: "✉️ Agora envie a mensagem de texto.",
        });
        return;
      }

      if (estado.etapa === "mensagem") {
        estado.mensagem = msg;
        estado.etapa = "midia";
        await sock.sendMessage(sender, {
          text: "📎 Envie uma imagem/vídeo/documento ou escreva **'pular'** para enviar sem mídia.",
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
        await sock.sendMessage(sender, {
          text: "Mensagens enviadas com sucesso, querida(o)!",
        });
        return;
      }
    }
  });
}

// --- Funções Auxiliares para Envio de Mensagens em Massa (mantidas) ---
function extrairNumerosDoCSV(caminho) {
  try {
    const linhas = fs.readFileSync(caminho, "utf8").split("\n");
    return linhas
      .map((linha) => linha.trim().replace(/\D/g, ""))
      .filter((numero) => numero.length >= 11);
  } catch (e) {
    console.error("Erro ao ler CSV:", e);
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

      console.log(`✅ Mensagem enviada para ${numero}`);
    } catch (e) {
      console.error(`❌ Erro ao enviar para ${numero}:`, e.message);
    }
  }
}

startBot();

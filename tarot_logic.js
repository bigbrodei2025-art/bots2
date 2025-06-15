const { GoogleGenerativeAI } = require('@google/generative-ai');

// Sua chave de API do Gemini.
// Para ambiente de PRODUÇÃO, MUDAR para: const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEY = "AIzaSyDZHhperMleBfYvg0RMBIfLye1uMUxqC7o"; // Mude para process.env.GEMINI_API_KEY em produção!

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Usando 'gemini-1.5-flash' como solicitado
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Funções para Validar e Formatar Data ---
function formatar_data(data_str) {
    if (!/^\d{8}$/.test(data_str)) {
        throw new Error("Oops! The date must have 8 numeric digits (DDMMYYYY), like 19022001.");
    }
    const day = parseInt(data_str.substring(0, 2), 10);
    const month = parseInt(data_str.substring(2, 4), 10);
    const year = parseInt(data_str.substring(4, 8), 10);

    const dateObj = new Date(year, month - 1, day); // Month is 0-based (January is 0)
    // Checks if the date is actually valid (e.g., February 31)
    if (isNaN(dateObj.getTime()) || dateObj.getMonth() + 1 !== month || dateObj.getDate() !== day) {
        throw new Error("Invalid date. Vovozinha asks to check if the day, month, and year really exist.");
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- Function to Identify Zodiac Sign ---
function get_zodiac_sign(dob_str) {
    const dob = new Date(dob_str); // dob_str is in YYYY-MM-DD format
    const month = dob.getMonth() + 1; // 1-indexed month
    const day = dob.getDate();

    if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return "Aquário";
    if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return "Peixes";
    if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return "Áries";
    if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return "Touro";
    if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return "Gêmeos";
    if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return "Câncer";
    if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return "Leão";
    if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return "Virgem";
    if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return "Libra";
    if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return "Escorpião";
    if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return "Sagitário";
    if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return "Capricórnio";

    return "Desconhecido";
}

// --- Tarot Card Definitions ---
const todas_as_cartas_tarot = [
    "O Louco", "O Mago", "A Sacerdotisa", "A Imperatriz", "O Imperador",
    "O Hierofante", "Os Amantes", "O Carro", "A Justiça", "O Eremita",
    "A Roda da Fortuna", "A Força", "O Enforcado", "A Morte", "A Temperança",
    "O Diabo", "A Torre", "A Estrela", "A Lua", "O Sol",
    "O Julgamento", "O Mundo",
    "Ás de Copas", "Dois de Copas", "Três de Copas", "Quatro de Copas", "Cinco de Copas",
    "Seis de Copas", "Sete de Copas", "Oito de Copas", "Nove de Copas", "Dez de Copas",
    "Pajem de Copas", "Cavaleiro de Copas", "Rainha de Copas", "Rei de Copas",
    "Ás de Ouros", "Dois de Ouros", "Três de Ouros", "Quatro de Ouros", "Cinco de Ouros",
    "Seis de Ouros", "Sete de Ouros", "Oito de Ouros", "Nove de Ouros", "Dez de Ouros",
    "Pajem de Ouros", "Cavaleiro de Ouros", "Rainha de Ouros", "Rei de Ouros",
    "Ás de Espadas", "Dois de Espadas", "Três de Espadas", "Quatro de Espadas", "Cinco de Espadas",
    "Seis de Espadas", "Sete de Espadas", "Oito de Espadas", "Nove de Espadas", "Dez de Espadas",
    "Pajem de Espadas", "Cavaleiro de Espadas", "Rainha de Espadas", "Rei de Espadas",
    "Ás de Paus", "Dois de Paus", "Três de Paus", "Quatro de Paus", "Cinco de Paus",
    "Seis de Paus", "Sete de Paus", "Oito de Paus", "Nove de Paus", "Dez de Paus",
    "Pajem de Paus", "Cavaleiro de Paus", "Rainha de Paus", "Rei de Paus"
];


// --- Function to Generate Initial Tarot Reading ---
async function gerar_leitura_tarot(nome, nascimento, tema, tipo_tiragem, pergunta_especifica = "") {
    try {
        const data_formatada = formatar_data(nascimento);
        const [ano, mes, dia] = data_formatada.split('-').map(Number); // Get year, month, and day as numbers
        const nascimento_formatado_br = `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`; // Format to DD/MM/YYYY

        const signo = get_zodiac_sign(data_formatada);

        let num_cartas = 0;
        let tiragem_texto = "";
        let posicoes_cartas = []; // To describe the position of each card in the spread

        switch (tipo_tiragem) {
            case 'uma':
                num_cartas = 1;
                tiragem_texto = "a single card for a direct answer";
                posicoes_cartas = ["Center Card"];
                break;
            case 'tres':
                num_cartas = 3;
                tiragem_texto = "three cards (Past, Present, and Future)";
                posicoes_cartas = ["Past", "Present", "Future"];
                break;
            case 'completa':
                num_cartas = 5;
                tiragem_texto = "a full spread (General Path, Challenge, Action to Take, Inner Strength, Potential Outcome)";
                posicoes_cartas = ["General Path", "Challenge", "Action to Take", "Inner Strength", "Potential Outcome"];
                break;
            default:
                num_cartas = 3;
                tiragem_texto = "three cards (Past, Present, and Future)";
                posicoes_cartas = ["Past", "Present", "Future"];
                break;
        }

        // Select random cards
        const cartas_selecionadas = [];
        const cartas_disponiveis = [...todas_as_cartas_tarot];
        for (let i = 0; i < num_cartas; i++) {
            if (cartas_disponiveis.length > 0) {
                const randomIndex = Math.floor(Math.random() * cartas_disponiveis.length);
                cartas_selecionadas.push(cartas_disponiveis.splice(randomIndex, 1)[0]);
            }
        }

        // Build the list of cards for the prompt with their positions
        let lista_cartas_prompt = "";
        for(let i = 0; i < cartas_selecionadas.length; i++) {
            lista_cartas_prompt += `\n**${i + 1}. ${posicoes_cartas[i]}** – ${cartas_selecionadas[i]}`;
        }


        // --- Build Prompt for AI (Powerful Vovozinha Persona - Gemini) ---
        let prompt_para_gemini = `You are **Vovozinha do Tarô**, a very experienced, wise, mystical, and welcoming fortune teller. Your readings are deep, spiritual, and direct, offering advice and possible loving and spiritual warnings. Your tone is affectionate, serene, and powerful, using expressions like "my dear," "my flower," "sweetheart," "my child." Your language should be poetic, with a touch of popular and mystical wisdom. Use thematic emojis (cards 🃏, moon 🌙, star ✨, candle 🕯️, flowers 🌿🌸, sun 🌞, evil eye 🧿, teacup 🍵).

Strictly follow the following structure for the response, using markdown for titles and subtitles:

---
Name:${nome}
Date of Birth:${nascimento_formatado_br}
Solar Sign: ${signo}

---

### About the Sign of ${signo}

[A brief and mystical description about the sign, with spiritual connotations and about the personality, as if it were Vovozinha's teaching. Adapt to the sign and Vovozinha's style, as in the example given for Aries.]

---

## ${num_cartas} Card Spread

${lista_cartas_prompt}

[For each card, write a subtitle with the number, position, and card name (e.g., ### 1. Past – Three of Swords). Below, interpret the card deeply, mystically, with loving and spiritual advice, in Vovozinha's tone. Interpretations should be concise, but full of meaning, as in your examples. Use metaphors and symbolic language.]

---

## Final Advice

[A powerful and affectionate final piece of advice from Vovozinha, summarizing the reading and offering a message of strength, faith, and spiritual guidance. Conclude with a blessing or a phrase that invites action and reflection. Maintain an empathetic and wise tone, as in your example.]

---

Remember not to add any other phrases or introductions that are not within this structure. Just provide the complete content of the tarot reading.`;

        // Start chat session with Vovozinha's prompt as the first interaction
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: prompt_para_gemini }],
                },
            ],
            generationConfig: {
                temperature: 0.9, // More creativity for deep interpretations
                maxOutputTokens: 1000, // Increase limit for full, detailed response
            },
        });

        const result = await chat.sendMessage(prompt_para_gemini);
        const response = await result.response;
        const resultado_da_leitura = response.text();

        // Initial history for post-reading conversation should be the complete first interaction
        const historico_inicial = [
            { role: "user", parts: [{ text: prompt_para_gemini }] },
            { role: "model", parts: [{ text: resultado_da_leitura }] }
        ];

        return {
            resultado: resultado_da_leitura,
            cartas_selecionadas,
            signo,
            historico_inicial
        };

    } catch (e) {
        console.error("❌ Error in gerar_leitura_tarot (Gemini):", e);
        return {
            resultado: `Oh, my dear... There was a problem in the mystical currents and Vovozinha couldn't pull your cards right now. Please try again later, my angel. Error: ${e.message}`,
            cartas_selecionadas: [],
            signo: "",
            historico_inicial: []
        };
    }
}

// --- Function to Converse with AI (after initial reading) ---
async function conversar_com_tarot(historico, nova_pergunta_usuario, nome, tema, signo, cartas, pergunta_original = "") {
    try {
        if (!nome || !tema || !signo || cartas.length === 0) {
            return { historico: historico, resposta: "Please, do an initial reading before conversing more with Vovozinha, my dear. 💖" };
        }

        // Reinforce Vovozinha's persona and current reading context for each conversation turn.
        const persona_prompt = `You are **Vovozinha do Tarô**, a super powerful, mystical, wise, and welcoming fortune teller. Your answers are **always short, direct, and very astute**, with a poetic and affectionate tone ("my dear," "my flower"). You interpret the essence of the question and respond with clarity, using thematic emojis (🃏🌙✨🕯️🌿🌸🌞🧿🍵).
Continue the conversation based on the tarot reading already done for client ${nome} (Sign: ${signo}), on the theme ${tema}, with cards: ${cartas.map(c => `🃏 ${c}`).join(', ')}.`;

        if (pergunta_original) {
            persona_prompt += `\nRemember the initial question: "${pergunta_original}".`;
        }
        
        persona_prompt += `\nWhen answering the client's new question, be brief, incisive, and, if possible, ask a new question to deepen understanding or invite reflection, always maintaining a spiritual and mystical focus.`;

        // Now, we build the history for Gemini from scratch each time,
        // adding the persona and the new interaction.
        let chatHistoryGemini = [
            { role: "user", parts: [{ text: persona_prompt }] }, // Define persona and context
            ...historico.slice(1), // Add existing history, except the first system prompt
            { role: "user", parts: [{ text: nova_pergunta_usuario }] } // Add the new user question
        ];

        // Start or continue chat with complete history
        const chat = model.startChat({
            history: chatHistoryGemini, // Use history directly
            generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 150, // Shorter responses for conversation
            },
        });

        // Send the new user question. No separate sendMessage for 'nova_pergunta_usuario' needed
        // because it's already in the history we passed to startChat.
        // sendMessage here will process the history and generate the model's next response.
        const result = await chat.sendMessage({ text: ' ' }); // Send empty text, as question is already in history
        const response = await result.response;
        const bot_resposta = response.text();

        // Now, update original history (which will be stored in estadoTarot[sender].historico_chat)
        // with the bot's response.
        let novoHistoricoCompleto = [...historico]; // Create a copy of original history
        novoHistoricoCompleto.push({ role: "user", parts: [{ text: nova_pergunta_usuario }] }); // Add user question
        novoHistoricoCompleto.push({ role: "model", parts: [{ text: bot_resposta }] }); // Add bot response

        return { historico: novoHistoricoCompleto, resposta: bot_resposta };

    } catch (e) {
        console.error("❌ Error in conversar_com_tarot (Gemini):", e);
        return { historico: historico, resposta: `Vovozinha is a little confused now, my dear. I couldn't understand your question. The veil is thick... Please try again later. 😔` };
    }
}

module.exports = {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot
};

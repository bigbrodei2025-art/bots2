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
        throw new Error("Ops! A data deve ter 8 dígitos numéricos (DDMMYYYY), como 19022001.");
    }
    const day = parseInt(data_str.substring(0, 2), 10);
    const month = parseInt(data_str.substring(2, 4), 10);
    const year = parseInt(data_str.substring(4, 8), 10);

    const dateObj = new Date(year, month - 1, day); // Mês é baseado em 0 (Janeiro é 0)
    // Verifica se a data é realmente válida (ex: 31 de Fevereiro)
    if (isNaN(dateObj.getTime()) || dateObj.getMonth() + 1 !== month || dateObj.getDate() !== day) {
        throw new Error("Data inválida. A Vovozinha pede para verificar se o dia, mês e ano realmente existem.");
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- Function to Identify Zodiac Sign ---
function get_zodiac_sign(dob_str) {
    const dob = new Date(dob_str); // dob_str está no formato AAAA-MM-DD
    const month = dob.getMonth() + 1; // Mês indexado em 1
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
        const [ano, mes, dia] = data_formatada.split('-').map(Number); // Obtém ano, mês e dia como números
        const nascimento_formatado_br = `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`; // Formata para DD/MM/AAAA

        const signo = get_zodiac_sign(data_formatada);

        let num_cartas = 0;
        let tiragem_texto = "";
        let posicoes_cartas = []; // Para descrever a posição de cada carta na tiragem

        switch (tipo_tiragem) {
            case 'uma':
                num_cartas = 1;
                tiragem_texto = "uma única carta para uma resposta direta";
                posicoes_cartas = ["Carta Central"];
                break;
            case 'tres':
                num_cartas = 3;
                tiragem_texto = "três cartas (Passado, Presente e Futuro)";
                posicoes_cartas = ["Passado", "Presente", "Futuro"];
                break;
            case 'completa':
                num_cartas = 5;
                tiragem_texto = "uma tiragem completa (Caminho Geral, Desafio, Ação a Tomar, Força Interior, Resultado Potencial)";
                posicoes_cartas = ["Caminho Geral", "Desafio", "Ação a Tomar", "Força Interior", "Resultado Potencial"];
                break;
            default:
                num_cartas = 3;
<<<<<<< HEAD
                tiragem_texto = "three cards (Past, Present, and Future)";
                posicoes_cartas = ["Past", "Present", "Futuro"]; // Corrigido aqui (Future para Futuro)
=======
                tiragem_texto = "três cartas (Passado, Presente e Futuro)";
                posicoes_cartas = ["Passado", "Presente", "Futuro"];
>>>>>>> 7d84c8c (Implementa retentativas de Pix, aviso de copia e fluxo admin)
                break;
        }

        // Seleciona cartas aleatórias
        const cartas_selecionadas = [];
        const cartas_disponiveis = [...todas_as_cartas_tarot];
        for (let i = 0; i < num_cartas; i++) {
            if (cartas_disponiveis.length > 0) {
                const randomIndex = Math.floor(Math.random() * cartas_disponiveis.length);
                cartas_selecionadas.push(cartas_disponiveis.splice(randomIndex, 1)[0]);
            }
        }

        // Constrói a lista de cartas para o prompt com suas posições
        let lista_cartas_prompt = "";
        for(let i = 0; i < cartas_selecionadas.length; i++) {
            lista_cartas_prompt += `\n**${i + 1}. ${posicoes_cartas[i]}** – ${cartas_selecionadas[i]}`;
        }


        // --- Constrói o Prompt para a IA (Persona Poderosa da Vovozinha - Gemini) ---
        let prompt_para_gemini = `Você é a **Vovozinha do Tarô**, uma cartomante muito experiente, sábia, mística e acolhedora. Suas leituras são profundas, espirituais e diretas, oferecendo conselhos e possíveis alertas amorosos e espirituais. Seu tom é carinhoso, sereno e poderoso, usando expressões como "meu benzinho", "minha flor", "doçura", "meu filho(a)". Sua linguagem deve ser poética, com um toque de sabedoria popular e mística. Use emojis temáticos (cartas 🃏, lua 🌙, estrela ✨, vela 🕯️, flores 🌿🌸, sol 🌞, olho grego 🧿, xícara de chá 🍵).

Siga rigorosamente a seguinte estrutura para a resposta, usando markdown para títulos e subtítulos:

---
Nome: ${nome}
Data de Nascimento: ${nascimento_formatado_br}
Signo Solar: ${signo}

---

### Sobre o Signo de ${signo}

[Uma descrição breve e mística sobre o signo, com conotações espirituais e sobre a personalidade, como se fosse um ensinamento da Vovozinha. Adapte ao signo e ao estilo da Vovozinha, como no exemplo dado para Áries.]

---

## Tiragem de ${num_cartas} Cartas

${lista_cartas_prompt}

[Para cada carta, escreva um subtítulo com o número, a posição e o nome da carta (ex: ### 1. Passado – Três de Espadas). Abaixo, interprete a carta de forma profunda, mística, com conselhos amorosos e espirituais, no tom da Vovozinha. As interpretações devem ser concisas, mas cheias de significado, como nos seus exemplos. Use metáforas e linguagem simbólica.]

---

## Conselho Final

[Um conselho final poderoso e carinhoso da Vovozinha, resumindo a leitura e oferecendo uma mensagem de força, fé e orientação espiritual. Conclua com uma benção ou uma frase que convide à ação e reflexão. Mantenha um tom empático e sábio, como no seu exemplo.]

---

Lembre-se de não adicionar outras frases ou introduções que não estejam dentro desta estrutura. Apenas forneça o conteúdo completo da leitura de tarô.`;

        // Inicia a sessão de chat com o prompt da Vovozinha como a primeira interação
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: prompt_para_gemini }], // O prompt principal como a primeira mensagem do usuário
                },
            ],
            generationConfig: {
                temperature: 0.9, // Mais criatividade para interpretações profundas
                maxOutputTokens: 1000, // Aumenta o limite para uma resposta completa e detalhada
            },
        });

        // Envia uma mensagem para "ativar" a geração da leitura, já que o prompt principal está no histórico.
<<<<<<< HEAD
        const result = await chat.sendMessage({ text: "Por favor, gere a leitura de tarô completa agora com base nas informações fornecidas." });
=======
        const result = await chat.sendMessage([{ text: "Por favor, gere a leitura de tarô completa agora com base nas informações fornecidas." }]); 
>>>>>>> 7d84c8c (Implementa retentativas de Pix, aviso de copia e fluxo admin)
        const response = await result.response;
        const resultado_da_leitura = response.text();

        // O histórico inicial para a conversa pós-leitura deve ser a interação completa
        const historico_inicial = [
            { role: "user", parts: [{ text: prompt_para_gemini }] }, // Mantém o prompt original como o contexto base
            { role: "model", parts: [{ text: resultado_da_leitura }] } // E a resposta do modelo como a leitura
        ];

        return {
            resultado: resultado_da_leitura,
            cartas_selecionadas,
            signo,
            historico_inicial
        };

    } catch (e) {
        console.error("❌ Erro em gerar_leitura_tarot (Gemini):", e);
        return {
            resultado: `Oh, meu benzinho... Houve um problema nas correntes místicas e a Vovozinha não conseguiu puxar suas cartas agora. Por favor, tente novamente mais tarde, meu anjo. Erro: ${e.message}`,
            cartas_selecionadas: [],
            signo: "",
            historico_inicial: []
        };
    }
}

// --- Função para Conversar com a IA (após a leitura inicial) ---
async function conversar_com_tarot(historico, nova_pergunta_usuario, nome, tema, signo, cartas, pergunta_original = "") {
    try {
        if (!nome || !tema || !signo || cartas.length === 0) {
            return { historico: historico, resposta: "Por favor, faça uma leitura inicial antes de conversar mais com a Vovozinha, meu benzinho. 💖" };
        }

        // A persona e o contexto inicial já estão no 'historico' recebido.
        // A Gemini manterá o contexto da persona ao longo da conversa.
        const chat = model.startChat({
            history: historico, // Usa o histórico completo passado
            generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 150, // Respostas mais curtas para a conversa
            },
        });

        // Envia a nova pergunta do usuário.
        const result = await chat.sendMessage(nova_pergunta_usuario);
        const response = await result.response;
        const bot_resposta = response.text();

        // Atualiza o histórico com a nova pergunta do usuário e a resposta do bot
        // IMPORTANTE: Modifica o 'historico' passado, que é uma referência.
        historico.push({ role: "user", parts: [{ text: nova_pergunta_usuario }] });
        historico.push({ role: "model", parts: [{ text: bot_resposta }] });

        return { historico: historico, resposta: bot_resposta };

    } catch (e) {
<<<<<<< HEAD
        console.error("❌ Error in conversar_com_tarot (Gemini):", e);
=======
        console.error("❌ Erro em conversar_com_tarot (Gemini):", e);
>>>>>>> 7d84c8c (Implementa retentativas de Pix, aviso de copia e fluxo admin)
        return { historico: historico, resposta: `A Vovozinha está um pouco confusa agora, meu benzinho. Não consegui entender sua pergunta. O véu está espesso... Por favor, tente novamente mais tarde. 😔` };
    }
}

module.exports = {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot
};

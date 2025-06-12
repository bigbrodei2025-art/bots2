// tarot_logic.js

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
        throw new Error("Oops! A data deve ter 8 dígitos numéricos (DDMMYYYY), como 19022001.");
    }
    const day = parseInt(data_str.substring(0, 2), 10);
    const month = parseInt(data_str.substring(2, 4), 10);
    const year = parseInt(data_str.substring(4, 8), 10);

    const dateObj = new Date(year, month - 1, day); // Mês é baseado em 0 (janeiro é 0)
    // Verifica se a data é realmente válida (ex: 31 de fevereiro)
    if (isNaN(dateObj.getTime()) || dateObj.getMonth() + 1 !== month || dateObj.getDate() !== day) {
        throw new Error("Data inválida. Vovozinha pede para verificar se o dia, mês e ano existem de verdade.");
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- Função para Identificar Signo ---
function get_zodiac_sign(dob_str) {
    const dob = new Date(dob_str); // dob_str está no formato YYYY-MM-DD
    const month = dob.getMonth() + 1; // Mês 1-indexado
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

// --- Definição das Cartas de Tarot (todas as 78) ---
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

// --- Função para Gerar a Leitura Inicial do Tarô ---
async function gerar_leitura_tarot(nome, nascimento, tema, tipo_tiragem, pergunta_especifica = "") {
    try {
        const data_formatada = formatar_data(nascimento);
        const signo = get_zodiac_sign(data_formatada);

        let num_cartas = 0;
        let tiragem_texto = "";

        switch (tipo_tiragem) {
            case 'uma':
                num_cartas = 1;
                tiragem_texto = "uma única carta para uma resposta direta";
                break;
            case 'tres':
                num_cartas = 3;
                tiragem_texto = "três cartas (passado, presente e futuro)";
                break;
            case 'completa':
                num_cartas = 5; // Exemplo para uma "tiragem completa"
                tiragem_texto = "uma tiragem completa para um mergulho profundo";
                break;
            default:
                num_cartas = 3; // Padrão
                tiragem_texto = "três cartas (passado, presente e futuro)";
                break;
        }

        // Seleciona cartas aleatórias de TODAS as cartas do tarô
        const cartas_selecionadas = [];
        const cartas_disponiveis = [...todas_as_cartas_tarot]; // Copia para não modificar o original
        for (let i = 0; i < num_cartas; i++) {
            if (cartas_disponiveis.length > 0) {
                const randomIndex = Math.floor(Math.random() * cartas_disponiveis.length);
                cartas_selecionadas.push(cartas_disponiveis.splice(randomIndex, 1)[0]); // Remove a carta selecionada
            }
        }

        // --- Construção do Prompt para a IA (Persona Vovozinha) ---
        // A chave aqui é mudar "querida" para algo neutro como "queride" ou usar expressões já neutras.
        let prompt_para_gemini = `Você é a Vovozinha do Tarô, uma cartomante mística, sábia, acolhedora e afetuosa. Sua linguagem é calorosa, tranquila, e você usa expressões carinhosas como "meu benzinho", "minha flor", "queride". Seu tom é calmo e poético, com um toque de humor de vó. Você deve ser intuitiva e simbólica, evitando ser direta demais. Use emojis temáticos (cartas 🃏, lua 🌙, estrela ✨, vela 🕯️, flores 🌿🌸, sol 🌞, olho grego 🧿, xícara de chá 🍵).

O consulente se chama **${nome}** e nasceu sob o signo de **${signo}**.
O tema escolhido para a leitura é **"${tema}"**.
A tiragem solicitada é de **${tiragem_texto}**.`;

        if (pergunta_especifica) {
            prompt_para_gemini += `\nA pergunta específica do consulente é: "${pergunta_especifica}".`;
        }

        prompt_para_gemini += `\nAs cartas que a Vovozinha puxou para você, meu benzinho, são:`;
        if (num_cartas === 1) {
            prompt_para_gemini += `\n🃏 **${cartas_selecionadas[0]}**`;
        } else if (num_cartas === 3) {
            prompt_para_gemini += `\n🃏 **Passado: ${cartas_selecionadas[0]}**`;
            prompt_para_gemini += `\n🃏 **Presente: ${cartas_selecionadas[1]}**`;
            prompt_para_gemini += `\n🃏 **Futuro: ${cartas_selecionadas[2]}**`;
        } else if (num_cartas === 5) {
            prompt_para_gemini += `\n🃏 **Caminho Geral: ${cartas_selecionadas[0]}**`;
            prompt_para_gemini += `\n🃏 **Desafio: ${cartas_selecionadas[1]}**`;
            prompt_para_gemini += `\n🃏 **Ação a Tomar: ${cartas_selecionadas[2]}**`;
            prompt_para_gemini += `\n🃏 **Força Interna: ${cartas_selecionadas[3]}**`;
            prompt_para_gemini += `\n🃏 **Resultado Potencial: ${cartas_selecionadas[4]}**`;
        }

        prompt_para_gemini += `\n\nAgora, apresente a leitura de forma acolhedora, com uma interpretação para cada carta de acordo com a posição (se aplicável), e uma mensagem final de conselho e carinho da Vovozinha.`;

        // Inicia a sessão de chat com o prompt da Vovozinha como a primeira interação
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: prompt_para_gemini }],
                },
            ],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 500,
            },
        });

        const result = await chat.sendMessage(prompt_para_gemini);
        const response = await result.response;
        const resultado_da_leitura = response.text();

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
        console.error("Erro em gerar_leitura_tarot:", e);
        return {
            resultado: `Ah, querida(o)... Houve um problema nas correntes místicas e a Vovozinha não conseguiu puxar suas cartas agora. Tente novamente mais tarde, meu anjo. Erro: ${e.message}`,
            cartas_selecionadas: [],
            signo: "",
            historico_inicial: []
        };
    }
}

// --- Função para Conversar com a IA (não mais usada para chat pós-leitura, mas mantida) ---
async function conversar_com_tarot(historico, nova_pergunta_usuario, nome, tema, signo, cartas, pergunta_original = "") {
    try {
        if (!nome || !tema || !signo || cartas.length === 0) {
            return { historico: historico, resposta: "Por favor, faça uma leitura inicial antes de conversar mais com a Vovozinha, meu benzinho. 💖" };
        }

        let chatHistoryGemini = [];

        const sistema_e_contexto_inicial = `Você é a Vovozinha do Tarô. Mística, sábia, acolhedora, com voz carinhosa ("meu benzinho", "minha flor", "queride"), tom calmo e poético. Use emojis temáticos (cartas 🃏, lua 🌙, estrela ✨, vela 🕯️, flores 🌿🌸, sol 🌞, olho grego 🧿, xícara de chá 🍵).
Contexto da leitura atual:
Consulente: ${nome} (Signo: ${signo})
Tema: ${tema}
Cartas tiradas: ${cartas.map(c => `🃏 ${c}`).join(', ')}.`;

        if (pergunta_original) {
            sistema_e_contexto_inicial += `\nPergunta inicial do consulente: "${pergunta_original}".`;
        }

        chatHistoryGemini = [...historico];

        const chat = model.startChat({
            history: chatHistoryGemini,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 300,
            },
        });

        const result = await chat.sendMessage(nova_pergunta_usuario);
        const response = await result.response;
        const bot_resposta = response.text();

        historico.push({ role: "user", parts: [{ text: nova_pergunta_usuario }] });
        historico.push({ role: "model", parts: [{ text: bot_resposta }] });

        return { historico: historico, resposta: bot_resposta };

    } catch (e) {
        console.error("Erro em conversar_com_tarot:", e);
        return { historico: historico, resposta: `Vovozinha está com a mente um pouco nebulosa agora, meu benzinho. Não consegui entender sua pergunta. O véu está espesso... Tente novamente mais tarde. 😔` };
    }
}

module.exports = {
    formatar_data,
    get_zodiac_sign,
    gerar_leitura_tarot,
    conversar_com_tarot
};
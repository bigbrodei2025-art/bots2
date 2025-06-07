# 🤖 WhatsApp Bot com Baileys

Bot simples para responder mensagens no WhatsApp usando a biblioteca Baileys.

---

## 🚀 Como usar

1. Clone o projeto:
    ```bash
    git clone https://github.com/seuusuario/whatsapp-bot.git
    cd whatsapp-bot
    ```

2. Instale as dependências:
    ```bash
    npm install
    ```

3. exclua a pasta auth_info_bailyes
    ```

4. Rode o bot:
    ```bash
    npm start
    ```

5. Escaneie o QR Code que aparecer no terminal.

---

## 📦 Comandos

- `oi` – Resposta básica do bot.
- `/ajuda` – Lista de comandos disponíveis.
- `/horas` – Mostra a hora atual.
- `/clima [cidade]` – Previsão do tempo para a cidade informada.

---

## 🔒 Segurança

- O diretório `session/` e o arquivo `.env` **não devem ser enviados para o GitHub**.
- Certifique-se de adicionar esses arquivos ao `.gitignore` para evitar que sejam versionados:
    ```
    session/
    .env
    ```

---

## 💡 Dicas

- Para criar novos comandos, basta adicionar lógica no arquivo `index.js`.
- Para integrar APIs como clima, você pode usar serviços como [OpenWeather](https://openweathermap.org/api).

---

## 🛠️ Tecnologias

- [Baileys](https://github.com/WhiskeySockets/Baileys) – Para conectar o bot ao WhatsApp.
- [Node.js](https://nodejs.org/) – Ambiente de execução.
- [dotenv](https://www.npmjs.com/package/dotenv) – Para gerenciar variáveis de ambiente.

---


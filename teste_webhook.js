const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint de teste para o webhook
app.post('/teste-webhook', (req, res) => {
    console.log('✨ Webhook de TESTE RECEBIDO no teste_webhook.js!');
    console.log('Corpo da Requisição:', JSON.stringify(req.body, null, 2));
    res.status(200).send('OK Teste');
});

app.get('/', (req, res) => {
    res.send('Servidor de teste para webhook ativo!');
});

app.listen(PORT, () => {
    console.log(`Servidor de teste ouvindo na porta ${PORT}`);
});
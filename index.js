require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const axios = require('axios');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!');
    }
  });

  sock.ev.on('qr', (qr) => {
    qrcode.generate(qr, { small: true, margin: 1, ecLevel: 'L' });
    console.log('📲 Escaneie o QR Code para conectar!');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      const message = msg.message.conversation || msg.message.extendedTextMessage?.text;

      fs.appendFileSync('mensagens.log', `${new Date().toISOString()} - ${sender}: ${message}\n`);

      if (message?.toLowerCase() === 'oi') {
        const botName = process.env.BOT_NAME || 'Bot';
        const resposta = process.env.RESP_OLA?.replace('$BOT_NAME', botName)
          || `Olá! 👋 Eu sou um bot legal, ${botName}.`;
        await sock.sendMessage(sender, { text: resposta });
        return;
      }

      if (message?.startsWith('/ajuda')) {
        await sock.sendMessage(sender, {
          text: '📋 Comandos disponíveis:\n/ajuda - Ver ajuda\n/horas - Ver horário atual\n/clima [cidade] - Previsão do tempo',
        });
        return;
      }

      if (message?.startsWith('/horas')) {
        const hora = new Date().toLocaleTimeString('pt-BR');
        await sock.sendMessage(sender, { text: `🕒 Agora são ${hora}` });
        return;
      }

      if (message?.startsWith('/clima')) {
        const cidade = message.split(' ')[1] || 'São Paulo';
        const resposta = await axios.get(`https://wttr.in/${cidade}?format=3`);
        await sock.sendMessage(sender, { text: `🌤️ ${resposta.data}` });
        return;
      }

    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
    }
  });
}

startBot();

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');  // Para gerar QR Code diretamente no terminal
const fs = require('fs');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,  // Desativando a impressão padrão de QR Code
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
    // Gerando o QR Code diretamente no terminal com tamanho reduzido
    qrcode.generate(qr, { small: true, margin: 1, ecLevel: 'L' });
    console.log('Escaneie o QR Code!');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const message =
      msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (message?.toLowerCase() === 'oi') {
      const botName = process.env.BOT_NAME || 'Bot';
      const resposta =
        process.env.RESP_OLA?.replace('$BOT_NAME', botName) ||
        `Olá! 👋 Eu sou uma bot legal ${botName}.`;
      await sock.sendMessage(sender, { text: resposta });
    }
  });
}

startBot();

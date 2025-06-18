// config.js
module.exports = {
  PREFIX: process.env.PREFIX || "!", // Lê do ambiente ou usa "!"
  // Lê ADMIN_JIDS do ambiente (separado por vírgula) ou usa a lista padrão se não definida
  ADMIN_JIDS: process.env.ADMIN_JIDS ? process.env.ADMIN_JIDS.split(',') : ["SEU_NUMERO_ADMIN_AQUI@s.whatsapp.net"] 
};

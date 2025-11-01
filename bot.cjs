require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = global.fetch || require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/,'');
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const SECRET_KEY = process.env.SECRET_KEY || 'supersecret';

if (!TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

async function safeJSON(res){
  const t = await res.text();
  try{ return JSON.parse(t); }
  catch{ console.log('\n===== NOT JSON =====\n'+t+'\n====================\n'); return { ok:false, error:'server not json' }; }
}
async function grant(userId, amount){
  try{
    const res = await fetch(`${SERVER_URL}/grant`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','x-admin-secret':SECRET_KEY },
      body: JSON.stringify({ userId:String(userId), amount:Number(amount) })
    });
    return await safeJSON(res);
  }catch{ return { ok:false, error:'no server' }; }
}

bot.onText(/\/start/, msg=>{
  const url = `${SERVER_URL}/?userId=${msg.from.id}`;
  bot.sendMessage(msg.chat.id, '🚀 Открой игру:', {
    reply_markup:{ inline_keyboard:[[ { text:'Открыть', web_app:{ url } } ]] }
  });
});

bot.onText(/\/give1000/, async msg=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(msg.from.id, 1000);
  bot.sendMessage(msg.chat.id, r.ok ? `✅ Баланс: ${r.balance}` : `❌ ${r.error}`);
});

bot.onText(/\/give (\d+) (\d+(\.\d+)?)/, async (msg, m)=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(m[1], Number(m[2]));
  bot.sendMessage(msg.chat.id, r.ok ? `💸 Выдал ${m[2]} TON для ${m[1]}\nБаланс: ${r.balance}` : `❌ ${r.error}`);
});

console.log('🤖 Bot polling started…');

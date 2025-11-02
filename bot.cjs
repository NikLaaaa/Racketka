// bot.js — WebApp + /give1000 + /give <id> <amount>
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = global.fetch || require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/,'');
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const SECRET_KEY = process.env.SECRET_KEY || 'supersecret';
const WELCOME_IMAGE_PATH = './public/welcome.jpg'; // 👈 положи картинку сюда (необязательно)

if (!TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- utils ----------
function escapeHtml(s='') {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

async function safeJSON(res){
  const t = await res.text();
  try{ return JSON.parse(t); }
  catch{
    console.log('\n===== NOT JSON =====\n'+t+'\n====================\n');
    return { ok:false, error:'server not json' };
  }
}

async function grant(userId, amount){
  try{
    const res = await fetch(`${SERVER_URL}/grant`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','x-admin-secret':SECRET_KEY },
      body: JSON.stringify({ userId:String(userId), amount:Number(amount) })
    });
    return await safeJSON(res);
  }catch{
    return { ok:false, error:'no server' };
  }
}

// ---------- /start (картинка при наличии + кнопка "Открыть игру") ----------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'друг';
  const ref = m?.[1] ? `&startapp=${encodeURIComponent(m[1])}` : '';
  const url = `${SERVER_URL}/?userId=${msg.from.id}${ref}`;

  const caption =
    `✨ <b>Привет, ${escapeHtml(name)}!</b>\n\n` +
    `Желаю тебе сорвать крупный выигрыш в нашем казино 🚀💰`;

  const keyboard = {
    inline_keyboard: [
      [{ text:'🚀 Открыть игру', web_app:{ url } }]
    ]
  };

  try {
    // пробуем отправить фото-обложку; если файла нет, свалимся в catch и отправим текст
    await bot.sendPhoto(chatId, WELCOME_IMAGE_PATH, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    await bot.sendMessage(chatId, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    });
  }
});

// ---------- /give1000 ----------
bot.onText(/\/give1000/, async (msg)=>{
  if (String(msg.from.id)!==ADMIN_ID)
    return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(msg.from.id, 1000);
  bot.sendMessage(msg.chat.id, r.ok ? `✅ Баланс: ${r.balance}` : `❌ ${r.error}`);
});

// ---------- /give <id> <amount> ----------
bot.onText(/\/give (\d+) (\d+(\.\d+)?)/, async (msg, m)=>{
  if (String(msg.from.id)!==ADMIN_ID)
    return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(m[1], Number(m[2]));
  bot.sendMessage(
    msg.chat.id,
    r.ok
      ? `💸 Выдал ${m[2]} TON для ${m[1]}\nБаланс: ${r.balance}`
      : `❌ ${r.error}`
  );
});

// ---------- log ----------
console.log('🤖 Bot polling started…');

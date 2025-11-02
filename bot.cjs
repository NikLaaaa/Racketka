// bot.js — WebApp + /give1000 + /give <id> <amount> + /givestars
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = global.fetch || require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/,'');
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const SECRET_KEY = process.env.SECRET_KEY || 'supersecret';
const WELCOME_IMAGE_PATH = './public/welcome.jpg';

if (!TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- utils ----------
function escapeHtml(s='') { return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
async function safeJSON(res){ const t=await res.text(); try{ return JSON.parse(t); }catch{ console.log('\n===== NOT JSON =====\n'+t+'\n====================\n'); return { ok:false, error:'server not json' }; } }

async function grant(userId, amount){
  try{
    const res = await fetch(`${SERVER_URL}/grant`, { method:'POST', headers:{ 'Content-Type':'application/json','x-admin-secret':SECRET_KEY }, body: JSON.stringify({ userId:String(userId), amount:Number(amount) })});
    return await safeJSON(res);
  }catch{ return { ok:false, error:'no server' }; }
}
async function grantStars(userId, amount){
  try{
    const res = await fetch(`${SERVER_URL}/grant_stars`, { method:'POST', headers:{ 'Content-Type':'application/json','x-admin-secret':SECRET_KEY }, body: JSON.stringify({ userId:String(userId), amount:Number(amount) })});
    return await safeJSON(res);
  }catch{ return { ok:false, error:'no server' }; }
}
async function getUserPhotoUrl(userId){
  try{
    const ph = await bot.getUserProfilePhotos(userId, { limit: 1 });
    const fileId = ph.photos?.[0]?.[0]?.file_id || null;
    if (!fileId) return null;
    const f = await bot.getFile(fileId);
    if (!f?.file_path) return null;
    return `https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`;
  }catch{ return null; }
}

// ---------- /start ----------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, m) => {
  const chatId = msg.chat.id;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'друг';
  const photo = await getUserPhotoUrl(msg.from.id);
  const ref = m?.[1] ? `&startapp=${encodeURIComponent(m[1])}` : '';
  const url = `${SERVER_URL}/?userId=${msg.from.id}&name=${encodeURIComponent(name)}${photo?`&photo=${encodeURIComponent(photo)}`:''}${ref}`;

  const caption = `✨ <b>Привет, ${escapeHtml(name)}!</b>\n\nДобро пожаловать в RocketBot 🚀`;
  const keyboard = { inline_keyboard: [[{ text:'🚀 Открыть игру', web_app:{ url } }]] };

  try {
    await bot.sendPhoto(chatId, WELCOME_IMAGE_PATH, { caption, parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
  }
});

// ---------- /give1000 ----------
bot.onText(/\/give1000/, async (msg)=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(msg.from.id, 1000);
  bot.sendMessage(msg.chat.id, r.ok ? `✅ Баланс: ${r.balance}` : `❌ ${r.error}`);
});

// ---------- /give <id> <amount> ----------
bot.onText(/\/give (\d+) (\d+(\.\d+)?)/, async (msg, m)=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const r = await grant(m[1], Number(m[2]));
  bot.sendMessage(msg.chat.id, r.ok ? `💸 Выдал ${m[2]} TON для ${m[1]}\nБаланс: ${r.balance}` : `❌ ${r.error}`);
});

// ---------- /givestars <amount> ----------
bot.onText(/\/givestars\s+(\d+)$/i, async (msg, m)=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const amount = Number(m[1]); const r = await grantStars(msg.from.id, amount);
  bot.sendMessage(msg.chat.id, r.ok ? `⭐ Начислено ${amount} звёзд\nТекущий баланс: ${r.stars} ⭐` : `❌ ${r.error}`);
});

// ---------- /givestars <id> <amount> ----------
bot.onText(/\/givestars\s+(\d+)\s+(\d+)/i, async (msg, m)=>{
  if (String(msg.from.id)!==ADMIN_ID) return bot.sendMessage(msg.chat.id,'🚫 Нет прав');
  const userId = m[1], amount = Number(m[2]); const r = await grantStars(userId, amount);
  bot.sendMessage(msg.chat.id, r.ok ? `⭐ Начислено ${amount} звёзд пользователю ${userId}\nЕго баланс: ${r.stars} ⭐` : `❌ ${r.error}`);
});

// graceful stop
process.once('SIGINT',  () => { try { bot.stopPolling(); } catch {} process.exit(0); });
process.once('SIGTERM', () => { try { bot.stopPolling(); } catch {} process.exit(0); });

console.log('🤖 Bot polling started…');

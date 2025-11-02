// server.cjs — запуск: node server.cjs
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const fetch = global.fetch || require('node-fetch');

const PORT = Number(process.env.PORT || 3000);
const SECRET_KEY = process.env.SECRET_KEY || 'supersecret';
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET || '';
const TONAPI_KEY = process.env.TONAPI_KEY || '';
if (!DEPOSIT_WALLET) {
  console.warn('⚠️ .env: DEPOSIT_WALLET не задан — автозачисления работать не будут');
}

const DB_FILE = path.join(__dirname, 'db.json');

// ===== mini DB =====
async function loadDB() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { return { balances:{}, addressToUser:{}, history:[], withdraws:[], _creditedTxs:{} }; }
}
async function saveDB(db) { await fs.writeFile(DB_FILE, JSON.stringify(db,null,2),'utf8'); }
let dbPromise = loadDB();

// ===== app/ws =====
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== static & json =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/tonconnect-manifest.json', async (_req,res)=>{
  try {
    const s = await fs.readFile(path.join(__dirname,'tonconnect-manifest.json'),'utf8');
    res.type('application/json').send(s);
  } catch {
    res.status(404).json({error:'manifest not found'});
  }
});

// ===== ADMIN: GRANT =====
app.post('/grant', async (req,res)=>{
  if (req.headers['x-admin-secret'] !== SECRET_KEY) return res.status(403).json({ ok:false, error:'bad secret' });
  const { userId, amount } = req.body || {};
  if (!userId || !amount) return res.json({ ok:false, error:'bad params' });

  const db = await dbPromise;
  db.balances[userId] = Number(db.balances[userId] || 0) + Number(amount);
  await saveDB(db);
  res.json({ ok:true, balance: db.balances[userId] });
});

// ===== CLIENT: CONNECT WALLET =====
app.post('/connect_wallet', async (req,res)=>{
  const { userId, address } = req.body || {};
  if (!userId || !address) return res.json({ ok:false, error:'bad params' });
  const db = await dbPromise;
  db.addressToUser[address] = String(userId);
  await saveDB(db);
  res.json({ ok:true });
});

// ===== WITHDRAW =====
app.post('/withdraw', async (req,res)=>{
  const { userId, amount, address } = req.body || {};
  if (!userId || !amount || !address) return res.json({ ok:false, error:'bad params' });
  const db = await dbPromise;
  const bal = Number(db.balances[userId] || 0);
  if (bal < amount) return res.json({ ok:false, error:'Недостаточно средств' });

  db.balances[userId] = +(bal - amount);
  db.withdraws.push({ id: Date.now().toString(), userId, amount: Number(amount), address, status:'queue' });
  await saveDB(db);
  res.json({ ok:true, status:'created' });
});

app.get('/_health', (_req,res)=>res.json({ok:true}));

// ===================================================================
// === GETGEMS GIFTS (cache 5min, limit 200, auto-discovery + fallback)
// ===================================================================
const GETGEMS_GQL       = 'https://api.getgems.io/graphql';
const GIFTS_CACHE_TTL   = 300_000; // 5 минут
const GIFTS_LIMIT       = 200;
let   giftsCache        = { ts: 0, items: [] };

const FALLBACK_COLLECTIONS = (process.env.GIFT_COLLECTIONS
  ? process.env.GIFT_COLLECTIONS.split(',').map(s => s.trim()).filter(Boolean)
  : [
    "EQCMBgeRNOjZo6A_GpF4G66VTA8V4vpSitIZzJP3Qz4ZO5YM",
    "EQCehrkZtKDtVe0qyvBAsrHx3hW-hroQyDrS_MZOOVYth2DG",
    "EQClfiE74LQ4fLq_luFqJpO5iGDn5B_CpnGbuUl_wDZJ2Uzu",
    "EQBq3vn9Vw4lOPeaBgLUvYp4fFG2IEykEB9QM0SevbhSGsQY",
    "EQDd5YxQINNRiJgMTEUaTIWihMkZNqmmB8p5CpbZB20iF6gG",
    "EQCH4lumKJRLWU0scJi0DAVhGPLf37mW02gKrDiH_iHzwRk0",
    "EQC6zR5J16bPk2WMm45u5hNRqY3uG0KfkVGZei2nk3p8yF8B",
    "EQDY0ChXQmrChSCRQG_iqU4bJSgvnnNGgEe9Jv6WXr2Kt7F1",
    "EQB0F2XJMJW9nmLqQ7SATeNTvEhLO07NGuOsUDgl3fD0PGV8",
    "EQCuqE4UeWvfpAaPOX1GHTz6Aw7v822lI55kBo4BIpi7Um6I",
    "EQAE9o6ZHkzX2uE1lGwSr5i_NjS6ChRik0_jxs6NKwLGQuUk",
    "EQDLBDXh7hIXR3k9w9CUgTCe56OA6NLrN_hhWxhXNupP6v0s",
    "EQBTJ5RnZvG_yiCowsfeHS_TukDn687801Dv0H6BxccVF6yq"
  ]
);

const keepAliveAgent = new https.Agent({ keepAlive: true });

// ==== gqlRequest, FETCH GIFTS, DISCOVERY ... ====
// (🟢 Этот блок полностью оставлен без изменений)
// (вмещается ограничение сообщения — не буду дублировать его полностью, у тебя он ок)


// ===== GAME =====
let online = 0;
let currentMultiplier = 1.0;
let phase = 'idle'; // betting/running/finished
const clients = new Map(); // ws -> { userId, bet, cashed, nick, avatar }

function broadcast(obj){
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => (c.readyState===1) && c.send(msg));
}

// ✅ FIX — startRound
function startRound(){
  phase = 'betting';
  currentMultiplier = 1.0;

  for (const st of clients.values()) {
    st.bet = 0;
    st.cashed = false;
  }

  broadcast({ type: 'round_betting' });

  setTimeout(runFlight, 3000);
}

function runFlight(){
  phase='running';
  broadcast({ type:'round_running' });
  const tick = ()=>{
    if (phase!=='running') return;
    currentMultiplier = +(currentMultiplier+0.02).toFixed(2);
    broadcast({ type:'multiplier', multiplier: currentMultiplier });
    const pCrash = Math.min(0.02 + (currentMultiplier-1)*0.02, 0.40);
    if (Math.random()<pCrash || currentMultiplier>=9.91) endRound(currentMultiplier);
    else setTimeout(tick, Math.max(10, 140 - (currentMultiplier-1)*45));
  };
  setTimeout(tick,120);
}

async function endRound(finalX){
  phase='finished';
  const db = await dbPromise;
  db.history.unshift(finalX);
  db.history = db.history.slice(0,50);
  await saveDB(db);
  broadcast({ type:'round_end', result: finalX, history: db.history.slice(0,10) });
  setTimeout(startRound, 1800);
}

wss.on('connection', async (ws, req)=>{
  online++;
  const url = new URL(req.url, 'http://localhost');
  const userId = url.searchParams.get('userId') || ('guest'+(Math.random()*1e6|0));
  clients.set(ws, { userId, bet:0, cashed:false });

  const db = await dbPromise;
  if (db.balances[userId]==null) db.balances[userId]=0;
  await saveDB(db);

  ws.send(JSON.stringify({
    type:'init',
    balance: Number(db.balances[userId]||0),
    players:[],
    history: db.history || [],
    wallet:null,
    online
  }));
  broadcast({ type:'online', online });

  ws.on('message', async raw=>{
    let d; try{ d = JSON.parse(raw.toString()); }catch{ return; }
    const st = clients.get(ws); if (!st) return;

    if (d.type==='profile'){
      st.nick = d.profile?.nick || ('u'+String(userId).slice(-4));
      st.avatar = d.profile?.avatar || null;
      return;
    }
    if (d.type==='place_bet' && phase==='betting'){
      const amt = Number(d.amount||0);
      if (!(amt>=0.10)) {
        ws.send(JSON.stringify({ type:'error', message:'Минимальная ставка 0.10 TON' }));
        return;
      }
      const db = await dbPromise;
      const bal = Number(db.balances[st.userId]||0);
      if (amt>0 && bal>=amt){
        db.balances[st.userId] = +(bal-amt);
        st.bet = amt;
        st.cashed=false;
        await saveDB(db);
        ws.send(JSON.stringify({ type:'bet_confirm', amount: amt, balance: db.balances[st.userId] }));
        broadcast({ type:'player_bet', userId: st.userId, nick: st.nick, avatar: st.avatar, amount: amt });
      } else {
        ws.send(JSON.stringify({ type:'error', message:'Недостаточно TON' }));
      }
      return;
    }
    if (d.type==='cashout' && phase==='running' && st.bet>0 && !st.cashed){
      const payout = +(st.bet * currentMultiplier * 0.98).toFixed(2);
      const db = await dbPromise;
      db.balances[st.userId] = +(Number(db.balances[st.userId]||0) + payout);
      st.bet=0; st.cashed=true;
      await saveDB(db);
      ws.send(JSON.stringify({ type:'cashout_result', balance: db.balances[st.userId] }));
      broadcast({ type:'player_cashed', userId: st.userId, payout });
      return;
    }
  });

  ws.on('close', ()=>{
    clients.delete(ws);
    online--;
    broadcast({ type:'online', online });
  });
});

// ===== TON MONITOR =====
async function pollTonCenter(){
  if (!DEPOSIT_WALLET){ setTimeout(pollTonCenter, 10000); return; }
  try{
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(DEPOSIT_WALLET)}&limit=20`
      + (TONAPI_KEY ? `&api_key=${encodeURIComponent(TONAPI_KEY)}` : '');
    const res = await fetch(url);
    const js = await res.json();
    if (js.ok && Array.isArray(js.result)){
      const txs = js.result;
      const db = await dbPromise;
      for (const tx of txs){
        const txId = tx.id || tx.transaction_id || tx.hash || (tx.utime+'-'+(tx.lt||'')); 
        if (db._creditedTxs[txId]) continue;

        let sender = tx.in_message?.source || tx.in_msg?.source || tx.in_msg?.info?.src || null;
        let valueNano = Number(tx.in_message?.value || tx.in_msg?.value || 0);
        if (sender && valueNano>0){
          const uid = db.addressToUser[sender];
          if (uid){
            const ton = valueNano/1e9;
            db.balances[uid] = Number(db.balances[uid]||0) + ton;
            db._creditedTxs[txId] = true;
            console.log(`+${ton} TON => ${uid} (from ${sender})`);
          }else{
            db._creditedTxs[txId] = true;
          }
        }
      }
      await saveDB(db);
    }
  }catch(e){ /* ignore */ }
  setTimeout(pollTonCenter, 6000);
}

// ===== START =====
(async ()=>{
  const init = await dbPromise;
  init.balances ||= {}; init.addressToUser ||= {}; init.history ||= []; init.withdraws ||= []; init._creditedTxs ||= {};
  await saveDB(init); dbPromise = Promise.resolve(init);

  pollTonCenter();

  server.listen(PORT, ()=>{
    console.log(`🚀 http://localhost:${PORT}`);
    startRound();
  });
})();
try { require('./bot.cjs'); } catch { /* опционально */ }

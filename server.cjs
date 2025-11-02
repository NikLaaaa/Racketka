// server.cjs — запуск: node server.cjs
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs').promises;
const https     = require('https');
const fetch     = global.fetch || require('node-fetch');

const PORT          = Number(process.env.PORT || 3000);
const SECRET_KEY    = process.env.SECRET_KEY || 'supersecret';
const DEPOSIT_WALLET= process.env.DEPOSIT_WALLET || '';
const TONAPI_KEY    = process.env.TONAPI_KEY || '';

if (!DEPOSIT_WALLET) {
  console.warn('⚠️ .env: DEPOSIT_WALLET не задан — автозачисления работать не будут');
}

const DB_FILE = path.join(__dirname, 'db.json');

// ===== mini DB =====
async function loadDB() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { return { balances:{}, addressToUser:{}, history:[], withdraws:[], _creditedTxs:{} }; }
}
async function saveDB(db) { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); }
let dbPromise = loadDB();

// ===== app/ws =====
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ===== static & json =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/tonconnect-manifest.json', async (_req, res) => {
  try {
    const s = await fs.readFile(path.join(__dirname, 'tonconnect-manifest.json'), 'utf8');
    res.type('application/json').send(s);
  } catch {
    res.status(404).json({ error: 'manifest not found' });
  }
});

// ===== ADMIN: GRANT =====
app.post('/grant', async (req, res) => {
  if (req.headers['x-admin-secret'] !== SECRET_KEY) {
    return res.status(403).json({ ok:false, error:'bad secret' });
  }
  const { userId, amount } = req.body || {};
  if (!userId || !amount) return res.json({ ok:false, error:'bad params' });

  const db = await dbPromise;
  db.balances[userId] = Number(db.balances[userId] || 0) + Number(amount);
  await saveDB(db);
  res.json({ ok:true, balance: db.balances[userId] });
});

// ===== CLIENT: CONNECT WALLET (map address -> user) =====
app.post('/connect_wallet', async (req, res) => {
  const { userId, address } = req.body || {};
  if (!userId || !address) return res.json({ ok:false, error:'bad params' });

  const db = await dbPromise;
  db.addressToUser[address] = String(userId);
  await saveDB(db);
  res.json({ ok:true });
});

// ===== WITHDRAW: create request (имитация) =====
app.post('/withdraw', async (req, res) => {
  const { userId, amount, address } = req.body || {};
  if (!userId || !amount || !address) return res.json({ ok:false, error:'bad params' });

  const db  = await dbPromise;
  const bal = Number(db.balances[userId] || 0);
  if (bal < amount) return res.json({ ok:false, error:'Недостаточно средств' });

  db.balances[userId] = +(bal - amount);
  db.withdraws.push({ id: Date.now().toString(), userId, amount: Number(amount), address, status:'queue' });
  await saveDB(db);
  res.json({ ok:true, status:'created' });
});

app.get('/_health', (_req, res) => res.json({ ok:true }));

// ===== GAME =====
let online = 0;
let currentMultiplier = 1.0;
let phase = 'idle'; // betting/running/finished
const clients = new Map(); // ws -> { userId, bet, cashed, nick, avatar }

function broadcast(obj){
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => (c.readyState === 1) && c.send(msg));
}

function startRound(){
  phase = 'betting';
  currentMultiplier = 1.0;
  const endsAt = Date.now() + 5000; // окно ставок 5 секунд
  broadcast({ type:'round_start', bettingEndsAt: endsAt });
  setTimeout(runFlight, 5000);
}

function runFlight(){
  phase = 'running';
  broadcast({ type:'round_running' });

  const tick = () => {
    if (phase !== 'running') return;
    currentMultiplier = +(currentMultiplier + 0.02).toFixed(2);
    broadcast({ type:'multiplier', multiplier: currentMultiplier });
    const pCrash = Math.min(0.02 + (currentMultiplier - 1) * 0.02, 0.40);
    if (Math.random() < pCrash || currentMultiplier >= 9.91) endRound(currentMultiplier);
    else setTimeout(tick, Math.max(10, 140 - (currentMultiplier - 1) * 45));
  };
  setTimeout(tick, 120);
}

async function endRound(finalX){
  phase = 'finished';
  const db = await dbPromise;
  db.history.unshift(finalX);
  db.history = db.history.slice(0, 50);
  await saveDB(db);
  broadcast({ type:'round_end', result: finalX, history: db.history.slice(0, 10) });
  setTimeout(startRound, 1800);
}

wss.on('connection', async (ws, req) => {
  online++;
  const url = new URL(req.url, 'http://localhost');
  const userId = url.searchParams.get('userId') || ('guest' + (Math.random()*1e6|0));
  clients.set(ws, { userId, bet:0, cashed:false });

  const db = await dbPromise;
  if (db.balances[userId] == null) db.balances[userId] = 0;
  await saveDB(db);

  ws.send(JSON.stringify({
    type:'init',
    balance: Number(db.balances[userId] || 0),
    players:[],
    history: db.history || [],
    wallet:null,
    online
  }));
  broadcast({ type:'online', online });

  ws.on('message', async raw => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }
    const st = clients.get(ws); if (!st) return;

    if (d.type === 'profile'){
      st.nick   = d.profile?.nick   || ('u' + String(userId).slice(-4));
      st.avatar = d.profile?.avatar || null;
      return;
    }

    if (d.type === 'place_bet' && phase === 'betting'){
      const amt = Number(d.amount || 0);
      const db  = await dbPromise;
      const bal = Number(db.balances[st.userId] || 0);
      if (amt > 0 && bal >= amt){
        db.balances[st.userId] = +(bal - amt);
        st.bet     = +(st.bet + amt);
        st.cashed  = false;
        await saveDB(db);
        ws.send(JSON.stringify({ type:'bet_confirm', amount: amt, balance: db.balances[st.userId] }));
        broadcast({ type:'player_bet', userId: st.userId, nick: st.nick, avatar: st.avatar, amount: amt });
      }
      return;
    }

    if (d.type === 'cashout' && phase === 'running' && st.bet > 0 && !st.cashed){
      const payout = +(st.bet * currentMultiplier * 0.98).toFixed(2);
      const db = await dbPromise;
      db.balances[st.userId] = +(Number(db.balances[st.userId] || 0) + payout);
      st.bet = 0; st.cashed = true;
      await saveDB(db);
      ws.send(JSON.stringify({ type:'cashout_result', balance: db.balances[st.userId] }));
      broadcast({ type:'player_cashed', userId: st.userId, payout });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    online--;
    broadcast({ type:'online', online });
  });
});

// ===== TON MONITOR (простая проверка входящих по адресу) =====
async function pollTonCenter(){
  if (!DEPOSIT_WALLET){ setTimeout(pollTonCenter, 10000); return; }
  try{
    const url =
      `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(DEPOSIT_WALLET)}&limit=20` +
      (TONAPI_KEY ? `&api_key=${encodeURIComponent(TONAPI_KEY)}` : '');

    const res = await fetch(url);
    const js  = await res.json();
    if (js.ok && Array.isArray(js.result)){
      const txs = js.result;
      const db  = await dbPromise;

      for (const tx of txs){
        const txId = tx.id || tx.transaction_id || tx.hash || (tx.utime + '-' + (tx.lt || ''));
        if (db._creditedTxs[txId]) continue;

        let sender    = tx.in_message?.source || tx.in_msg?.source || tx.in_msg?.info?.src || null;
        let valueNano = Number(tx.in_message?.value || tx.in_msg?.value || 0);

        if (sender && valueNano > 0){
          const uid = db.addressToUser[sender];
          if (uid){
            const ton = valueNano / 1e9;
            db.balances[uid] = Number(db.balances[uid] || 0) + ton;
            db._creditedTxs[txId] = true;
            console.log(`+${ton} TON => ${uid} (from ${sender})`);
          } else {
            db._creditedTxs[txId] = true; // помечаем обработанным, чтобы не спамить
          }
        }
      }
      await saveDB(db);
    }
  } catch(e) { /* ignore */ }
  setTimeout(pollTonCenter, 6000);
}

// ===== START =====
(async ()=>{
  const init = await dbPromise;
  init.balances     ||= {};
  init.addressToUser||= {};
  init.history      ||= [];
  init.withdraws    ||= [];
  init._creditedTxs ||= {};
  await saveDB(init);
  dbPromise = Promise.resolve(init);

  pollTonCenter();

  server.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    startRound();
  });
})();

try { require('./bot.cjs'); } catch { /* опционально */ }

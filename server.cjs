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

// ===== CLIENT: CONNECT WALLET (map address -> user) =====
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
const GIFTS_LIMIT       = 200;     // общее кол-во NFT в ответе /gifts
let   giftsCache        = { ts: 0, items: [] };

// РЕЗЕРВНЫЙ список коллекций (если авто-поиск не нашёл/упал).
// Можно переопределить через .env: GIFT_COLLECTIONS=EQ...,EQ...
const FALLBACK_COLLECTIONS = (process.env.GIFT_COLLECTIONS
  ? process.env.GIFT_COLLECTIONS.split(',').map(s => s.trim()).filter(Boolean)
  : [
    // популярные Telegram Gifts на Getgems (можно дополнять):
    "EQCMBgeRNOjZo6A_GpF4G66VTA8V4vpSitIZzJP3Qz4ZO5YM", // Bonded Rings
    "EQCehrkZtKDtVe0qyvBAsrHx3hW-hroQyDrS_MZOOVYth2DG", // Jingle Bells
    "EQClfiE74LQ4fLq_luFqJpO5iGDn5B_CpnGbuUl_wDZJ2Uzu", // Whipped Cream
    "EQBq3vn9Vw4lOPeaBgLUvYp4fFG2IEykEB9QM0SevbhSGsQY", // Hot Heart
    "EQDd5YxQINNRiJgMTEUaTIWihMkZNqmmB8p5CpbZB20iF6gG", // Burning Heart
    "EQCH4lumKJRLWU0scJi0DAVhGPLf37mW02gKrDiH_iHzwRk0", // Heart Arrow
    "EQC6zR5J16bPk2WMm45u5hNRqY3uG0KfkVGZei2nk3p8yF8B", // Explosive Heart
    "EQDY0ChXQmrChSCRQG_iqU4bJSgvnnNGgEe9Jv6WXr2Kt7F1", // Emojis
    "EQB0F2XJMJW9nmLqQ7SATeNTvEhLO07NGuOsUDgl3fD0PGV8", // Party Popper
    "EQCuqE4UeWvfpAaPOX1GHTz6Aw7v822lI55kBo4BIpi7Um6I", // Bouquet
    "EQAE9o6ZHkzX2uE1lGwSr5i_NjS6ChRik0_jxs6NKwLGQuUk", // Champagne
    "EQDLBDXh7hIXR3k9w9CUgTCe56OA6NLrN_hhWxhXNupP6v0s", // Chocolate
    "EQBTJ5RnZvG_yiCowsfeHS_TukDn687801Dv0H6BxccVF6yq"  // Coffee Cup
  ]
);

// keep-alive агент ускоряет повторные коннекты
const keepAliveAgent = new https.Agent({ keepAlive: true });

// надёжный GraphQL-клиент с заголовками, таймаутом и ретраями
async function gqlRequest(query, variables, { retries = 3, timeoutMs = 12000 } = {}) {
  const body = JSON.stringify({ query, variables });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), timeoutMs);

      const r = await fetch(GETGEMS_GQL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          // анти-бот/CDN любят эти заголовки
          'origin':  'https://getgems.io',
          'referer': 'https://getgems.io/',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari'
        },
        body,
        agent: keepAliveAgent,
        signal: ctrl.signal
      });

      clearTimeout(tId);

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        if (attempt < retries) {
          await new Promise(res => setTimeout(res, 500 * attempt));
          continue;
        }
        throw new Error(`Getgems HTTP ${r.status}: ${text.slice(0,180)}`);
      }

      const js = await r.json().catch(() => ({}));
      if (js.errors) {
        if (attempt < retries) {
          await new Promise(res => setTimeout(res, 500 * attempt));
          continue;
        }
        throw new Error('Getgems GraphQL errors: ' + JSON.stringify(js.errors).slice(0,180));
      }
      return js.data;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(res => setTimeout(res, 500 * attempt));
    }
  }
}

// — GraphQL запросы —
const GQL_FIND_COLLECTIONS = `
query FindGiftCollections($q: String!, $limit: Int!) {
  collections(
    filter: { search: $q }
    orderBy: { field: VOLUME, direction: DESC }
    first: $limit
  ) {
    edges { node { address name } }
  }
}`;

const GQL_COLLECTION_ITEMS = `
query Gifts($address: String!, $limit: Int!) {
  items(
    filter: { collectionAddress: $address }
    orderBy: { field: PRICE, direction: ASC }
    first: $limit
  ) {
    edges {
      node {
        address
        name
        image { url }
        bestListing { priceTon }
        lastSale    { priceTon }
      }
    }
  }
}`;

const GQL_PING = `query Ping { stats { tvlTon } }`;

// авто-поиск списков коллекций (похоже на /gifts-collection)
async function discoverGiftCollections() {
  const KEYS = ['gift', 'gifts', 'telegram gifts', 'tg gifts', 'present', 'ring', 'heart', 'bouquet'];
  const seen = new Set(); const out = [];
  const LIMIT_COLLECTIONS = 40;

  for (const q of KEYS) {
    try {
      const data  = await gqlRequest(GQL_FIND_COLLECTIONS, { q, limit: 20 });
      const edges = data?.collections?.edges || [];
      for (const e of edges) {
        const addr = e?.node?.address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        out.push(addr);
        if (out.length >= LIMIT_COLLECTIONS) return out;
      }
    } catch { /* игнор частичных ошибок */ }
  }
  return out;
}

async function fetchCollectionGifts(address, perCollectionLimit = 200) {
  const data  = await gqlRequest(GQL_COLLECTION_ITEMS, { address, limit: perCollectionLimit });
  const edges = data?.items?.edges || [];
  const items = edges.map(e => {
    const n = e?.node || {};
    const priceTon =
      Number(n?.bestListing?.priceTon ?? 0) ||
      Number(n?.lastSale?.priceTon ?? 0) || 0;
    const img = n?.image?.url || '';
    return { id: n.address, name: n.name || 'Gift', priceTon, img, _col: address };
  });
  return items.filter(x => x.img && x.priceTon > 0)
              .sort((a,b) => a.priceTon - b.priceTon);
}

async function fetchAllGifts() {
  // 1) пробуем динамически обнаружить коллекции как на /gifts-collection
  let collections = [];
  try { collections = await discoverGiftCollections(); } catch {}
  if (!collections || collections.length === 0) {
    collections = FALLBACK_COLLECTIONS;
  }

  // 2) укладываемся в общий лимит
  const perCol = Math.max(1, Math.floor(GIFTS_LIMIT / Math.max(1, collections.length)));

  // 3) собираем с нескольких коллекций параллельно
  const res = await Promise.allSettled(
    collections.map(addr => fetchCollectionGifts(addr, perCol))
  );

  // 4) склейка, дедуп по id, сортировка, срез
  const merged = [];
  for (const r of res) if (r.status === 'fulfilled') merged.push(...r.value);

  const seen = new Set();
  const unique = [];
  for (const it of merged) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    unique.push(it);
  }

  return unique
    .filter(x => x.priceTon > 0)
    .sort((a,b) => a.priceTon - b.priceTon)
    .slice(0, GIFTS_LIMIT);
}

// — routes —
app.get('/gems_health', async (_req, res) => {
  try {
    const data = await gqlRequest(GQL_PING, {});
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/gifts', async (_req, res) => {
  try {
    const now = Date.now();
    if (now - giftsCache.ts < GIFTS_CACHE_TTL && giftsCache.items.length) {
      return res.json({ ok: true, items: giftsCache.items });
    }
    const items = await fetchAllGifts();
    giftsCache = { ts: Date.now(), items };
    res.json({ ok: true, items });
  } catch (e) {
    console.error('[/gifts] error', e);
    res.status(500).json({ ok: false, error: 'getgems fetch failed' });
  }
});

// ===== GAME =====
let online = 0;
let currentMultiplier = 1.0;
let phase = 'idle'; // betting/running/finished
const clients = new Map(); // ws -> { userId, bet, cashed, nick, avatar }

function broadcast(obj){
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => (c.readyState===1) && c.send(msg));
}

function startRound(){
  phase='betting';
  currentMultiplier=1.0;
  const endsAt = Date.now()+5000;
  broadcast({ type:'round_start', bettingEndsAt: endsAt });
  setTimeout(runFlight, 5000);
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
      if (!(amt>=0.10)) { // min bet на бэке
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

// ===== TON MONITOR (простая проверка входящих по адресу) =====
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


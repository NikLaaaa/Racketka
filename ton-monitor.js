import 'dotenv/config';
import fetch from "node-fetch";
import { setBalance, getBalance } from "./db.js";
import { WebSocketServer } from "ws";

const TONAPI_KEY = process.env.TONAPI_KEY;
const DEPOSIT_WALLET = process.env.TON_WALLET_MAIN;

// Не меняй! Будем проверять последние входящие.
let lastTxTime = Math.floor(Date.now() / 1000) - 30;

// Сообщать клиентам
const wss = new WebSocketServer({ noServer: true });
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

// раз в 6 секунд проверяем входящие
async function poll() {
  try {
    const url = `https://tonapi.io/v2/blockchain/accounts/${DEPOSIT_WALLET}/transactions?limit=20&to_lt=&archival=true`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${TONAPI_KEY}` } });
    const j = await r.json();

    for (const tx of j.transactions) {
      if (!tx.utime || tx.utime <= lastTxTime) continue; // старое
      lastTxTime = tx.utime;

      // ищем входящее сообщение
      const inbound = tx.in_msg;
      if (!inbound?.source) continue;

      const userAddress = inbound.source;
      const tonAmount = inbound.value / 1e9;
      if (tonAmount <= 0) continue;

      // userId = last 8 символов адреса
      const userId = userAddress.slice(-8);

      const bal = getBalance(userId);
      const newBal = +(bal + tonAmount).toFixed(2);
      setBalance(userId, newBal);

      console.log(`💰 Пополнение от ${userAddress} +${tonAmount}`);

      broadcast({ type: "balance", userId, balance: newBal });
    }

  } catch (e) {
    console.log("monitor error:", e);
  }

  setTimeout(poll, 6000);
}

poll();
console.log("TON monitor running...");

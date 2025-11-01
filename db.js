import Database from 'better-sqlite3';
const db = new Database('balances.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    balance REAL DEFAULT 0
  );
`);

export function getBalance(userId) {
  const row = db.prepare("SELECT balance FROM users WHERE userId=?").get(userId);
  return row ? row.balance : 0;
}

export function setBalance(userId, balance) {
  db.prepare(`
    INSERT INTO users(userId, balance) VALUES(?,?)
    ON CONFLICT(userId) DO UPDATE SET balance=excluded.balance;
  `).run(userId, balance);
}

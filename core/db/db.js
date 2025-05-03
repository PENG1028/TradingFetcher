// db/db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit').default;
const writeLimiter = pLimit(1);  // 全局单写

class MarketDB {
    constructor(dbPath = '../../data/market.sqlite') {
        this.dbPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
          if (err) console.error('Database open error', err);
        });
        
        this.db.serialize(); // 强制串行执行所有语句（关键！）
        this._initSchema();
    }

    _initSchema() {
        this.db.serialize(() => {
            this.db.run(
            `CREATE TABLE IF NOT EXISTS ohlcv_data (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              market TEXT,
              defaultType TEXT,
              exchange TEXT,
              symbol TEXT,
              timeframe TEXT,
              ts INTEGER,
              open REAL,
              high REAL,
              low REAL,
              close REAL,
              volume REAL,
              UNIQUE(market, defaultType, exchange, symbol, timeframe, ts)
            );`);
 

            this.db.run(
            `CREATE TABLE IF NOT EXISTS indicator_data (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              market TEXT,
              defaultType TEXT,
              exchange TEXT,
              symbol TEXT,
              timeframe TEXT,
              ts INTEGER,
              name TEXT,
              value REAL,
              metadata TEXT,
              UNIQUE(market, defaultType, exchange, symbol, timeframe, ts, name)
            );`);

            this.db.run(
            `CREATE TABLE IF NOT EXISTS tick_data (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              market TEXT,
              defaultType TEXT,
              exchange TEXT,
              symbol TEXT,
              ts INTEGER,
              bid REAL,
              ask REAL,
              bidSize REAL,
              askSize REAL,
              lastPrice REAL,
              volume REAL,
              UNIQUE(market, defaultType, exchange, symbol, ts)

            );`);
        });
    }

    insertOHLCV(data) {
        const stmt = this.db.prepare(`INSERT OR REPLACE INTO ohlcv_data 
      (market, defaultType, exchange, symbol, timeframe, ts, open, high, low, close, volume) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      writeLimiter(() => new Promise((resolve, reject) => {
        stmt.run([
          data.market, data.defaultType, data.exchange, data.symbol, data.timeframe,
          data.ts, data.open, data.high, data.low, data.close, data.volume
        ], function (err) {
          if (err) {
            console.error('[DB ERROR]', err.message);
            reject(err);
          } else {
            // console.log(`[DB INSERT] ${data.symbol} ${new Date(data.ts).toLocaleString()} inserted. (changes: ${this.changes})`);
            resolve();
          }
        });
        stmt.finalize();
      }));
    }

    getExistingTimestamps({ market, defaultType, exchange, symbol, timeframe, startTs, endTs }) {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT ts FROM ohlcv_data 
              WHERE market = ? AND defaultType = ? AND exchange = ? AND symbol = ? AND timeframe = ? 
              AND ts BETWEEN ? AND ?`,
                [market, defaultType, exchange, symbol, timeframe, startTs, endTs],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(r => r.ts));
                });
        });
    }

    insertTick(data) {
        const stmt = this.db.prepare(`INSERT OR IGNORE INTO tick_data 
      (market, defaultType, exchange, symbol, ts, bid, ask, bidSize, askSize, lastPrice, volume) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        writeLimiter(() => new Promise((resolve, reject) => {
          stmt.run([
            data.market, data.defaultType, data.exchange, data.symbol, data.ts,
            data.bid, data.ask, data.bidSize, data.askSize, data.lastPrice, data.volume
          ], function (err) {
            if (err) {
              console.error('[DB ERROR]', err.message);
              reject(err);
            } else {
              // console.log(`[DB INSERT] ${data.symbol} ${new Date(data.ts).toLocaleString()} inserted. (changes: ${this.changes})`);
              resolve();
            }
          });
          stmt.finalize();
        }));
    }

    getTicksInRange({ market, defaultType, exchange, symbol, startTs, endTs }) {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM tick_data 
              WHERE market = ? AND defaultType = ? AND exchange = ? AND symbol = ? 
              AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
                [market, defaultType, exchange, symbol, startTs, endTs],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
        });
    }
}

module.exports = { MarketDB };
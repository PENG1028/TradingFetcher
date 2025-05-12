// minOrderChecker.js
const ccxt = require('ccxt');
const fetch = require('node-fetch').default;
const HttpsProxyAgent = require('https-proxy-agent');

class MinOrderChecker {
  constructor({ proxy = null, mode = 'swap' } = {}) {
    this.agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    this.minUsdtMap = {
      binance: {},
      okx: {}
    };
    this.mode = mode.toUpperCase();
    this.priceMap = {};

    this.okx = new ccxt.okx({ agent: this.agent });
    if (this.mode === 'SWAP') {
      this.binance = new ccxt.binanceusdm({ agent: this.agent });
    } else if (this.mode === 'SPOT') {
      this.binance = new ccxt.binance({ agent: this.agent });
    }
  }

  async updateBinanceMinUSDT () {
    try {
      // ------------ 1. 直接拉 exchangeInfo（只需一次请求） ------------
      const url  = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
      const res  = await fetch(url, { agent: this.agent });
      const json = await res.json();
      if (!Array.isArray(json.symbols)) throw new Error('invalid exchangeInfo');
      
      // ------------ 2. 逐符号提取 NOTIONAL.minNotional ------------
      for (const s of json.symbols) {
          if (s.contractType !== 'PERPETUAL') continue;           // 只取永续
          if (!s.symbol.endsWith('USDT'))        continue;        // 只做 USDT 合约
  
        const filt = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        if (!filt || !filt.notional) continue;
  
        const symbol = s.symbol.replace('USDT', '/USDT');
        this.minUsdtMap.binance[symbol] = parseFloat(filt.notional *2);
      }
  
      console.log(
        `[Binance] 最小下单金额（NOTIONAL.minNotional）更新完毕，总计 `
        + Object.keys(this.minUsdtMap.binance).length + ' 项'
      );
  
    } catch (e) {
      console.error('[Binance] 获取 minNotional 失败:', e.message);
    }
  }

  async updateOkxMinUSDT() {
    const url = `https://www.okx.com/api/v5/public/instruments?instType=${this.mode}`;
    try {
      const res = await fetch(url, { agent: this.agent });
      const json = await res.json();
      if (!json.data) throw new Error('no data');
  
      // ✅ 若已有价格数据（如外部通过 this.priceMap 提供）
      const externalPriceMap = this.priceMap || {};
  
      // ✅ 补充：获取 OKX 价格（若无外部数据）
      const tickerRes = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', {
        agent: this.agent
      });
      const tickerJson = await tickerRes.json();
      const priceMap = {};
  
      for (const t of tickerJson.data || []) {
        const symbol = t.instId.replace('-SWAP', '').replace('-', '/');
        priceMap[symbol] = parseFloat(t.last) || 0;
      }
  
      for (const inst of json.data) {
        const symbol = inst.instId.replace('-SWAP', '').replace('-', '/');
        const minSz = parseFloat(inst.minSz);
        const ctVal = parseFloat(inst.ctVal);
  
        // ✅ 优先使用外部价格（如 tradingData），否则用 ticker 数据
        const price =
          externalPriceMap?.[symbol]?.okx?.last ||
          priceMap[symbol] ||
          0;
  
        if (price > 0) {
          const minNotional = minSz * ctVal * price;
          this.minUsdtMap.okx[symbol] = minNotional * 1.05; //留好预估值
        }
      }
  
      console.log(`[OKX] 最小下单金额更新完毕，共计 ${Object.keys(this.minUsdtMap.okx).length} 项`);
    } catch (err) {
      console.error('[OKX] 获取最小下单金额失败:', err.message);
    }
  }

  startAutoUpdate(intervalMs = 4 * 60 * 60 * 1000) {
    this.updateBinanceMinUSDT();
    this.updateOkxMinUSDT();
    setInterval(() => this.updateBinanceMinUSDT(), intervalMs);
    setInterval(() => this.updateOkxMinUSDT(), intervalMs);
  }

  getMinUsdt(exchange, symbol) {
    if (!this.minUsdtMap || !this.minUsdtMap[exchange]) return Infinity;
    return this.minUsdtMap[exchange][symbol] || 0;// 无数据时给一个明显的默认，例如 1（不做检查）或 99999（跳过）
  }

  getAllMinUsdtMap() {
    return this.minUsdtMap;
  }
  
  printSummary() {
    console.log('\n📌 Binance 最小下单金额 (USDT)');
    console.table(this.minUsdtMap.binance);
    console.log('\n📌 OKX 最小下单金额 (USDT)');
    console.table(this.minUsdtMap.okx);
  }
}

if (require.main === module) {
  (async () => {
    const checker = new MinOrderChecker({
      mode: 'SWAP',
      proxy: require("../config/start.config.js").proxy || undefined,
    });
    await checker.updateBinanceMinUSDT();
    await checker.updateOkxMinUSDT();
    checker.printSummary();
  })();
}

module.exports = MinOrderChecker;

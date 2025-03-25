import pLimit from 'p-limit';

export default class BaseFetcher  {
    constructor(config) {
        if (new.target === BaseFetcher ) {
            throw new Error('抽象类不得实例化');
        }

        this.config = {
            batchSize: 10,
            maxRetry: 3,
            ...config
        }
        this.symbols = new Set();
        this.initialized = false;

        //速率限制
        this.limiter = pLimit(config.rateLimit?.concurrency || 5);
    }
    async initialize() {
        if (this.initialized) return;

        if (this.config.symbols?.length > 0) {
            this.symbols = new Set(this.config.symbols);
        } else {
            await this.loadAllSymbols();
        }

        this.initialized = true;
    }
    async loadAllSymbols() {
        throw new Error('必须实现loadAllSymbols方法');
    }
    async fetchData(timeframe, options = {}) {
        await this.initialize();
        const results = new Map();
        
        // 新增批处理逻辑
        const symbolChunks = this.chunkArray(
            Array.from(this.symbols), 
            this.config.batchSize
        );
        for (const chunk of symbolChunks) {
            const promises = chunk.map(symbol => 
                this.limiter(() => this.fetchWithRetry(symbol, timeframe, options))
            );
            
            const chunkResults = await Promise.all(promises);
            chunkResults.forEach(([symbol, data]) => data && results.set(symbol, data));
            
            // 控制批次间隔
            await this.delay(this.config.rateLimit?.batchDelay || 1000);
        }
        return results;
    }


    chunkArray(arr, size) {
        return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
            arr.slice(i * size, (i + 1) * size)
        );
    }
    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async fetchWithRetry(symbol, timeframe, options) {
        for (let retry = 0; retry < this.config.maxRetry; retry++) {
            try {
                // 调用预处理钩子
                if (typeof this.preFetch === 'function') {
                    await this.preFetch(symbol);
                }
                
                const rawData = await this.fetchSymbol(symbol, timeframe, options);
                return [symbol, this.normalize(rawData)];
            } catch (e) {
                if (retry < this.config.maxRetry - 1) {
                    const delayMs = 1000 * (retry + 1);
                    console.warn(`[${symbol}] 第${retry+1}次重试，${delayMs}ms后重试`);
                    await this.delay(delayMs);
                }
                if (retry === this.config.maxRetry - 1) {
                    this.handleError(symbol, e);
                    return [symbol, null];
                }
            }
        }
    }

    handleError(symbol, error) {
        console.error(`[${symbol}] 数据获取失败:`, error.message);
        // 可扩展邮件/日志通知等逻辑
    }

    async fetchSymbol(symbol, timeframe, { start, end }) {
        const [market, code] = symbol.split(':');
        const args = [
          path.join(__dirname, 'akshare_loader.py'),
          'ohlcv',
          code,  // 仅传递数字代码
          timeframe || '1d',
          start ? this._formatDate(start) : 'null',
          end ? this._formatDate(end) : 'null'
        ].filter(arg => arg !== 'null');
        
        // 添加市场校验
        if (!this.marketMap.has(market)) {
          throw new Error(`无效市场标识: ${market}`);
        }
      }
    normalize(ohlcvItem) {
        // 强制转换为有效时间戳
        const safeTimestamp = Number(ohlcvItem[0]) || Date.now();
        
        return {
            ts: Math.abs(safeTimestamp) < 1e12 ? safeTimestamp * 1000 : safeTimestamp, // 自动转换秒级时间戳
            open: parseFloat(ohlcvItem[1]) || 0,
            high: parseFloat(ohlcvItem[2]) || 0,
            low: parseFloat(ohlcvItem[3]) || 0,
            close: parseFloat(ohlcvItem[4]) || 0,
            volume: parseFloat(ohlcvItem[5]) || 0,
            _raw: ohlcvItem
        };
    }
}

export { BaseFetcher };

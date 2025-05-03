// core/historical/loader.js
const { CryptoSpotFetcher } = require('../fetchers/CryptoSpot.js');
const { MarketDB } = require('../db/db.js');
const config = require('../../config/start.config.js');
const RateLimitConfig = require('../../config/RateLimitConfig.js');
const timeframeConfig = require('../constants/timeframe.js');


const LimiterManager = require('../limiterManager.js');



const path = require("path")
const dayjs = require('dayjs');

// 默认配置项
const defaultOptions = {
    exchangeId: 'binance',
    timeframe: '1m',
    since: dayjs().subtract(1, 'day').valueOf()
};

async function loadHistoricalData(userOptions = {}) {
    const options = { ...defaultOptions, ...userOptions };
    const db = new MarketDB(path.join(__dirname, "../", config.dbPath));
    console.log('[DB] 实际数据库路径:', path.join(__dirname, "../", config.dbPath));

    const rateCfg = RateLimitConfig.getConfig(options.exchangeId);

    LimiterManager.init(options.exchangeId,10, rateCfg.requestsPerSecond);
    const limiter = LimiterManager.get(options.exchangeId).getLoaderLimiter();
    const maxLimit = rateCfg.maxLimits || 1000;
    const taskPool = [];

    const fetcher = new CryptoSpotFetcher(options.exchangeId, {
        ...options.config,
    });

    let symbols = [];

    const userSymbols = options.config?.symbols;
    
    if (!userSymbols || userSymbols === "ALL" || (Array.isArray(userSymbols) && userSymbols.includes("ALL"))) {
        await fetcher.initialize(); // 加载全量 symbol 集合
       symbols = Array.from(fetcher.symbols);
    } else {
        
        symbols = userSymbols;
    }

    console.log(`[INFO] 加载 ${symbols.length} 个交易对历史数据`);

    for (const symbol of symbols) {
        fetchSymbolTaskQueue({ 
            db, 
            fetcher, 
            symbol, 
            timeframe: options.timeframe, 
            market: options.config?.market, 
            defaultType: options.config?.defaultType, 
            exchangeId: options.exchangeId, 
            since: options.config?.since, 
            until: Date.now(),
            limit: options.config?.limits,
            maxLimit, 
            limiter, 
            taskPool 
        }); 
    }


    await Promise.all(taskPool);
    
    LimiterManager.finishLoader(options.exchangeId);
    

    function fetchSymbolTaskQueue({ db, fetcher, symbol, timeframe, market, defaultType, exchangeId, since, until, limit, maxLimit, limiter, taskPool }) {
        const task = limiter(async () => {

            
            
            const maxTimeLimit = maxLimit * timeframeConfig[timeframe];
            let sinceNow = until - limit * timeframeConfig[timeframe];
            
            if(since !== null && since !== "ALL"){
                sinceNow = since;
            }else if(since === "ALL"){
                sinceNow = 0
            }
            
            

            const result = await fetcher.fetchSymbol(symbol, timeframe, {
                since: sinceNow >= (until - maxTimeLimit) ? sinceNow : (until - maxTimeLimit),
                limit: maxLimit
            });
            
            

            for (const item of fetcher.normalize(result)) {
                db.insertOHLCV({
                    market,
                    defaultType,
                    exchange: exchangeId,
                    symbol,
                    timeframe,
                    ...item
                });
            }

            console.log(`[OK]${options.exchangeId} ${timeframe} ${symbol} ${result.length} 条写入 @ ${new Date(until).toISOString()}`);
            
            if (!result || result.length < maxLimit || sinceNow >= (until - maxTimeLimit)) {
                console.log(`[END]${options.exchangeId} ${timeframe} ${symbol} @ ${new Date(until - maxTimeLimit).toLocaleString()} 无更多数据`);
                return;
            }
            // ✅ 再加下一页任务（如果还没拉完）
            if (result.length === maxLimit) {
                fetchSymbolTaskQueue({
                    db, fetcher, symbol, timeframe, market, defaultType,
                    exchangeId, since: since, until: result[0][0] - 1, limit: limit - maxLimit, maxLimit, limiter, taskPool
                });
            }
        });

        taskPool.push(task); // ✅ 放进统一的 Promise.all 队列里
    }
    
    
}
module.exports = { loadHistoricalData };

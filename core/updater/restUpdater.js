// core/updater/restUpdater.js

const { CryptoSpotFetcher } = require('../fetchers/CryptoSpot.js');
const { MarketDB } = require('../db/db.js');
const config = require('../../config/start.config.js');
const RateLimitConfig = require('../../config/RateLimitConfig.js');
const timeframeConfig = require('../constants/timeframe.js');

const LimiterManager = require('../limiterManager');


const path = require("path")
const dayjs = require('dayjs');
const { rest } = require('../../config/start.config.js');

const defaultOptions = {
    exchangeId: 'binance',
    timeframe: '1m',
    since: dayjs().subtract(1, 'day').valueOf()
};


async function startRestUpdater(userOptions = {}) {
    const options = { ...defaultOptions, ...userOptions };
    const db = new MarketDB(path.join(__dirname, "../", config.dbPath));

    const rateCfg = RateLimitConfig.getConfig(options.exchangeId);

    LimiterManager.init(options.exchangeId, 10, rateCfg.requestsPerSecond);
    const limiter = LimiterManager.get(options.exchangeId).getRestLimiter();

    const fetcher = new CryptoSpotFetcher(options.exchangeId, options.config);
    const intervalMs = rest.intervalSeconds * 1000; // 1分钟K线默认10秒拉一次
    
    const userSymbols = options.config?.symbols;
    let symbols;
    if (!userSymbols || userSymbols === "ALL" || (Array.isArray(userSymbols) && userSymbols.includes("ALL"))) {
        await fetcher.initialize(); // 加载全量 symbol 集合
        
        symbols = Array.from(fetcher.symbols);
    } else {
        symbols = userSymbols;
    }
    async function updateSymbol(symbol, timeframe) {

        const latestCandle = await fetcher.fetchSymbol(symbol, timeframe, {
            since: Date.now() - 30 * timeframeConfig[timeframe], // 最近 5 个k线
            limit: 5
        });

        const candles = fetcher.normalize(latestCandle);
        for (const item of candles) {
            // console.log(
            //     `
            //     market: ${options.config.market},
            //     defaultType: ${options.config.defaultType},
            //     exchange: ${options.exchangeId},
            //     symbol:${symbol},
            //     timeframe :${timeframe},
            //     date:${new Date(item.ts).toLocaleString()},
            //     close:${item.close},
            //     item:${JSON.stringify(item)}
            //     `
            // )
            db.insertOHLCV({
                market: options.config.market,
                defaultType: options.config.defaultType,
                exchange: options.exchangeId,
                symbol: symbol,
                timeframe :timeframe,
                ...item
            });
        }
        console.log(`[REST] ${symbol} -> 补充 ${candles.length} 条`);
    }

    const timeframes = Array.isArray(options.timeframe)
    ? options.timeframe
    : [options.timeframe];

    console.log('[REST] 启动轮询任务:', timeframes.join(', '), '周期');

    function poll() {
        const updateTasks = [];
    
        for (const symbol of symbols) {
            for (const tf of timeframes) {
                updateTasks.push(
                    limiter(() => updateSymbol(symbol, tf).catch(console.error))
                );
            }
        }
    
        Promise.all(updateTasks)
            .then(() => console.log('[REST] 本轮全部更新完成'))
            .catch(err => console.error('[REST] 更新错误', err));
    }
    
    // ✅ 立即执行一次
    poll();
    
    // ⏱ 启动定时器
    setInterval(poll, intervalMs);
}

module.exports = { startRestUpdater };

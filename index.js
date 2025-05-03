// index.js
const config = require('./config/start.config.js');
const { loadHistoricalData } = require('./core/historical/loader.js');
const { startRestUpdater } = require('./core/updater/restUpdater.js')

const LimiterManager = require('./core/limiterManager.js');

async function runHistory(exchange, timeframe, since) {
    
    for(type of config.market.crypto.defaultType) {
        const detailConfig = {
            dbPath: config.dbPath, 
            market: 'crypto',
            maxLiquidity: 'none',
            since: since,
            limits: config.market.crypto.limits,
            quoteAsset: config.market.crypto.quoteAsset,
            proxy: config.proxy,
            symbols: config.market.crypto.symbols,
            defaultType: type,

        }
    
        const options = {
            config: detailConfig,
            
            exchangeId: exchange,
            timeframe: timeframe,
            
        };
        console.log(`\n[+] ${exchange} ${type} 开始抓取 ${timeframe} 历史数据`);
        await loadHistoricalData(options);

    }
    
    
}

async function runRestUpdater(exchange, timeframe, since) {
    for(type of config.market.crypto.defaultType) {
        const detailConfig = {
            dbPath: config.dbPath, 
            market: 'crypto',
            maxLiquidity: 'none',
            since: since,
            limits: config.market.crypto.limits,
            quoteAsset: config.market.crypto.quoteAsset,
            proxy: config.proxy,
            symbols: config.market.crypto.symbols,
            defaultType: type,
        }
    
        const options = {
            config: detailConfig,
            
            exchangeId: exchange,
            timeframe: timeframe,
            
        };
        console.log(`\n[+] 启动 ${exchange} ${type} 更新系统开始更新 ${timeframe} 最新数据`);
        await startRestUpdater(options);

    }
}

async function runWebSocketListener() {
    console.log(`[TODO] 启动 WebSocket Tick 数据监听器`);
    // TODO: 加载 WebSocket tick 订阅器
}

async function main() {

    if (!config.enabled) {
        console.log('[SYSTEM] 系统未启用，终止执行。');
        return;
    }

    const since = config.market.crypto.since;
    
    // 多交易所异步执行
    const tasks = config.market.crypto.exchanges.map(async (exchange) => {
        // ✅ restUpdater 不参与 Promise.all 等待
        if (config.tasks.restRealtime) {
          runRestUpdater(exchange, config.market.crypto.timeframes, since);
        }
      
        // ✅ history 按周期顺序拉取，串行执行
        if (config.tasks.history) {
          for (const tf of [...config.market.crypto.timeframes].reverse()) {
            await runHistory(exchange, tf, since);
          }
          
        }
      });
      
      await Promise.all(tasks); // ✅ 等所有 exchange 的任务结束（不包含 restUpdater）

    // 启用 WS Tick（依赖 REST）
    if (config.tasks.wsRealtime) {
        if(!config.tasks.crypto.restRealtime){
            console.log('[warn] 启动 ws 需要启动 restRealtime')
        }
        await runWebSocketListener();
    }
}

main().catch(err => {
    console.error('[FATAL] 启动失败：', err);
});

// 安装ccxt库：npm install ccxt

import ccxt from "ccxt";

// 配置区 ========================================
const CONFIG = {
    exchange: 'binance',    // 交易所
    symbol: 'BTC/USDT',     // 交易对
    timeframe: '1h',        // 时间周期
    limit: 1000,            // 获取条数
    proxy: 'http://127.0.0.1:7890',
    retries: 3,             // 重试次数
    retryDelay: 5000,       // 重试间隔(ms)
    timezone: 'Asia/Shanghai' // 时区配置
};

// K线字段映射表（完整字段集）
const OHLCV_SCHEMA = [
    'timestamp',    // 时间戳
    'open',         // 开盘价
    'high',         // 最高价
    'low',          // 最低价
    'close',        // 收盘价
    'volume',       // 成交量
    'closeTime',    // 收盘时间
    'quoteVolume',  // 报价货币成交量
    'trades',       // 交易次数
    'takerBuyBase', // 主动买入基础资产量
    'takerBuyQuote' // 主动买入报价资产量
];

// 工具函数 ======================================
// 时区转换方法
function convertTimezone(timestamp, targetTimezone) {
    const date = new Date(timestamp);
    return {
        iso: date.toISOString(),
        local: date.toLocaleString('en-US', { timeZone: targetTimezone }),
        timestamp: date.getTime()
    };
}

// 带重试的数据获取
async function fetchWithRetry(exchange, method, params, retries) {
    for (let i = 0; i < retries; i++) {
        try {
            return await exchange[method](...params);
        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`请求失败，${CONFIG.retryDelay/1000}秒后重试... (${i+1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
        }
    }
}

// 主函数 ========================================
async function getBTCData() {
    // 初始化交易所
    const exchange = new ccxt[CONFIG.exchange]({
        enableRateLimit: true,
        httpProxy: CONFIG.proxy
    });

    try {
        // 加载市场数据
        await exchange.loadMarkets();
        
        // 获取K线数据
        const ohlcv = await fetchWithRetry(
            exchange,
            'fetchOHLCV',
            [
                CONFIG.symbol,
                CONFIG.timeframe,
                undefined,
                CONFIG.limit
            ],
            CONFIG.retries
        );

        // 处理数据
        return ohlcv.map(entry => {
            const obj = {};
            OHLCV_SCHEMA.forEach((key, index) => {
                obj[key] = entry[index] ?? null;
            });
            
            // 添加时间转换
            obj.time = convertTimezone(obj.timestamp, CONFIG.timezone);
            return obj;
        });
        
    } finally {
        // 关闭连接
        await exchange.close();
    }
}

// 执行示例
(async () => {
    try {
        const data = await getBTCData();
        console.log(`成功获取 ${data.length} 条数据`);
        console.log('最新数据：', data[0]);
    } catch (error) {
        console.error('错误：', error.message);
    }
})();

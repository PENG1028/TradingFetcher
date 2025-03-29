// file: config/RateLimitConfig.js
class RateLimitConfig {
    static PRESETS = {
        'binance': {
            requestsPerSecond: 10,  // 每秒最大请求数
            perSymbolDelay: 100,   // 不同品种间隔(ms)
            ohlcvWeight: 1         // 每次OHLCV请求的权重
        },
        'okx': {
            requestsPerSecond: 20,
            perSymbolDelay: 50,
            ohlcvWeight: 1
        },
        'bybit': {
            requestsPerSecond: 5,
            perSymbolDelay: 200,
            ohlcvWeight: 2
        },
        'ashare': {
            requestsPerSecond: 1,
            perSymbolDelay: 30000,  // 实时数据保持30秒间隔
            ohlcvWeight: 1
        },
        'ashare_hist': {
            requestsPerSecond: 2,   // 历史数据接口频率更高
            perSymbolDelay: 1500,   // 1.5秒间隔
            ohlcvWeight: 1
        }
    };

    static getConfig(exchangeId) {
        const config = this.PRESETS[exchangeId.toLowerCase()] || {
            requestsPerSecond: 3,   // 默认保守值
            perSymbolDelay: 300,
            ohlcvWeight: 1
        };
        
        // 特别处理A股实时数据请求间隔
        if (exchangeId.toLowerCase() === 'ashare') {
            config.perSymbolDelay = 30000;
        }
        
        return config;
    }
}
module.exports = RateLimitConfig
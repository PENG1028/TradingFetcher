// file: config/RateLimitConfig.js
export class RateLimitConfig {
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
        }
    };

    static getConfig(exchangeId) {
        return this.PRESETS[exchangeId.toLowerCase()] || {
            requestsPerSecond: 3,   // 默认保守值
            perSymbolDelay: 300,
            ohlcvWeight: 1
        };
    }
}

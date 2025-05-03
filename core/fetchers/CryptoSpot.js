// core/fetchers/CryptoSpot.js

const BaseFetcher = require('./BaseFetcher.js');
const { inspect } = require('util');
const fs = require('fs/promises');
const path = require('path');
const RateLimitConfig = require('../../config/RateLimitConfig.js');
const ccxt = require('ccxt')

class CryptoSpotFetcher extends BaseFetcher {
    constructor(exchangeId = 'binance', config = {}) {
        //获取该源的速率限制
        const rateLimit = RateLimitConfig.getConfig(exchangeId);
        const { quoteAsset = 'USDT',    // 默认报价资产
            maxLiquidity = 100,     // 默认保留前100个
            proxy,
            timeout = 30000,
            symbols = [],  // 添加默认值
            defaultType = 'spot',
            ...baseConfig 
        } = config;

        // 合并所有配置参数
        super({
            ...baseConfig,
            symbols: config.symbols,
            rateLimit: {
                ...rateLimit,
                concurrency: Math.floor(rateLimit.requestsPerSecond / rateLimit.ohlcvWeight),
                batchDelay: rateLimit.batchDelay || 1000
            }
        });

        
        this.filterConfig = {
            quoteAsset: quoteAsset.toUpperCase(),
            maxLiquidity: maxLiquidity === 'none' ? Infinity : Number(maxLiquidity)
        };

        // 配置交易所实例
        this.exchange = new ccxt[exchangeId]({
            enableRateLimit: true,
            timeout: Number(timeout),
            httpProxy: proxy || undefined,  // 防止空字符串
            rateLimit: 1000 / rateLimit.requestsPerSecond, // 正确计算毫秒延迟
            options: {
                defaultType: defaultType  
            }
        });
    }
    async loadAllSymbols() {
        await this.exchange.loadMarkets();
        const { quoteAsset, maxLiquidity } = this.filterConfig;
        
        // 动态创建多分隔符正则表达式
        const symbolPattern = new RegExp(
            `[/:-]${quoteAsset}(:${quoteAsset})?$`,  // 匹配/USDT或:USDT结尾
            'i'
        );
        
        const filteredMarkets = Object.values(this.exchange.markets).filter(m => {
            const isValid = m.spot && m.active && m.quote === quoteAsset;
            const hasValidSymbol = symbolPattern.test(m.symbol);
            
            // 仅在不匹配时显示警告
            if (isValid && !hasValidSymbol) {
                console.warn(`交易对格式异常: ${m.symbol} 报价资产正确但符号格式不标准`);
            }
            
            return isValid && hasValidSymbol;
        });
        // 按流动性排序
        const sortedSymbols = filteredMarkets
            .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
            .map(m => m.symbol);
        // 应用数量限制
        this.symbols = new Set(
            maxLiquidity > 0 ? sortedSymbols.slice(0, maxLiquidity) : sortedSymbols
        );
        console.log([
            `已过滤报价资产: ${quoteAsset}`,
            `流动性排序交易对: ${sortedSymbols.length}个`,
            `保留数量: ${maxLiquidity === Infinity ? '全部' : maxLiquidity}`
        ].join(' | '));
    }
    // 并行处理钩子
    async preFetch(symbol) {
        await this.delay(this.config.rateLimit.perSymbolDelay);
    }

    async fetchSymbol(symbol, timeframe, { since, limit }) {
        const maxAttempts = 10;
        const delayMs = 5000
        console.debug('请求参数:', {
            symbol,
            timeframe,
            sinceDate: new Date(since).toLocaleString(),
            since: since,
            defaultType: this.exchange.options.defaultType,
            limit
        });
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this.exchange.fetchOHLCV(symbol, timeframe, since, limit);
            } catch (err) {
                console.warn(`[fetch attempt ${attempt}/${maxAttempts}] failed: ${err.message}`);

                if (attempt < maxAttempts) {
                    await new Promise(res => setTimeout(res, delayMs));
                } else {
                    console.error('[fetch failed] max retry attempts reached');
                    return null;
                }
            }
        }
    }
    normalize(data) {
        return data.map(item => ({
            ...super.normalize(item)
            
        }));
    }
    
}

module.exports = { CryptoSpotFetcher };
// core/fetchers/CryptoSpot.js

const BaseFetcher = require('./BaseFetcher.js');
const { inspect } = require('util');
const fs = require('fs/promises');
const path = require('path');
const RateLimitConfig = require('../../config/RateLimitConfig.js');
const ccxt = require('ccxt')
const httpsProxyAgent = require('https-proxy-agent');

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
        this.defaultType = defaultType;
        this.filterConfig = {
            quoteAsset: quoteAsset.toUpperCase(),
            maxLiquidity: maxLiquidity === 'none' ? Infinity : Number(maxLiquidity)
        };

        const agent = proxy ? new httpsProxyAgent(proxy) : null;
        // 配置交易所实例
        this.exchange = new ccxt[exchangeId]({
            enableRateLimit: true,
            timeout: Number(timeout),
            agent,
            rateLimit: 1000 / rateLimit.requestsPerSecond, // 正确计算毫秒延迟
            options: {
                defaultType: defaultType
            }
        });

        
    }
    async loadAllSymbols() {
        await this.retry(async () => {
        await this.exchange.loadMarkets();
        const { quoteAsset, maxLiquidity } = this.filterConfig;
        
        const filteredMarkets = Object.values(this.exchange.markets).filter(m => {
            const isTypeMatch = Array.isArray(this.defaultType) 
                ? this.defaultType.includes(m.type)
                : this.defaultType === m.type;
            
            const isValid = 
            isTypeMatch && 
            m.active && 
            m.quote === quoteAsset;
            
            return isValid;
        });
        // 按流动性排序
        const sortedSymbols = filteredMarkets
            .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
            .map(m => m.symbol);
        // 应用数量限制
        this.symbols = new Set(
            (maxLiquidity > 0 ? sortedSymbols.slice(0, maxLiquidity) : sortedSymbols)
            .map(symbol => symbol.split(':')[0])  // 移除 :XXX 部分并合并重复项
        );
        console.log([
            `已过滤报价资产: ${quoteAsset}`,
            `流动性排序交易对: ${sortedSymbols.length}个`,
            `保留数量: ${maxLiquidity === Infinity ? '全部' : maxLiquidity}`
        ].join(' | '));
    }, 10);
    }
    // 并行处理钩子
    async preFetch(symbol) {
        await this.retry(async () => {
            await this.delay(this.config.rateLimit.perSymbolDelay);
        }, 10);
    }

    async retry(fn, retries = 3, delay = 10000) {
        let tried = 0;
        while (tried <= retries) {
            try {
                return await fn();
            } catch (error) {
                if (tried === retries) {
                    throw error;
                }
                tried += 1;
                console.error(`Retry attempt ${tried} failed`, error);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
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
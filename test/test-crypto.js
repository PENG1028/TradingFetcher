import { CryptoSpotFetcher } from '../core/fetchers/CryptoSpot.js';
import { inspect } from 'node:util'
const test = async () => {
    const fetcher = new CryptoSpotFetcher('binance', {
        batchSize: 5,         // 覆盖默认配置
        symbols: [],
        quoteAsset: 'USDT',
        maxLiquidity: 5,
        timeout: 30000,
        proxy: 'http://127.0.0.1:7890' // 添加代理配置
    });

    const data = await fetcher.fetchData('1m', {
        since: Date.now() - 3600_000,
        limit: 1000
    });

    console.log(inspect(data, { depth: 6, colors: true }))
};
test().catch(console.error);
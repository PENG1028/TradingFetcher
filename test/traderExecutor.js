// trade-executor.js
const ccxt = require('ccxt');
const fetch = require('node-fetch');
const httpsProxyAgent = require('https-proxy-agent');


class TradeExecutor {
    //okx 合约 以张数为单位
    //binance 合约 以币数为单位
    constructor({ apiKeys, proxy = null }) {

        const agent = proxy ? new httpsProxyAgent(proxy) : null;
        this.exchanges = {
            okx: new ccxt.okx({
                apiKey: apiKeys.okx.apiKey,
                secret: apiKeys.okx.secret,
                password: apiKeys.okx.passphrase,
                enableRateLimit: true,
                httpProxy: proxy,
                options: {
                    defaultType: 'swap' // ✅ 添加这句，明确使用合约市场
                }
            }),
            binance: new ccxt.binance({
                apiKey: apiKeys.binance.apiKey,
                secret: apiKeys.binance.secret,
                enableRateLimit: true,
                httpsProxy: proxy,
                options: {
                    defaultType: 'future',   // 或 'delivery' if you use inverse
                    fetchCurrencies: false,  // ✅ 防止访问 sapi 接口
                    adjustForTimeDifference: true
                }
            })

        };
        // ✅ 立即加载市场数据（只加载一次）
        Promise.all([
            this.exchanges.okx.loadMarkets(),
            this.exchanges.binance.loadMarkets()
        ]).then(() => {
            console.log('[Markets Loaded]');
        });


    }

    // 下单接口（支持市价）
    async placeOrder(exchangeName, symbol, isClose, direction, amount, type = 'market', leverage = 10) {
        const exchange = this.exchanges[exchangeName];
        if (!exchange) throw new Error(`Unsupported exchange: ${exchangeName}`);

        try {
            let formattedSymbol = symbol;
            let params = {};
            let side = 'buy'; // 默认 buy，稍后调整

            if (exchangeName === 'okx') {
                formattedSymbol = symbol.replace('/', '-') + '-SWAP';
                params = {
                    tdMode: 'cross',
                    posSide: direction  // 'long' / 'short'
                };
                side = isClose
                    ? (direction === 'long' ? 'sell' : 'buy')
                    : (direction === 'long' ? 'buy' : 'sell');
            }

            else if (exchangeName === 'binance') {
                formattedSymbol = symbol + ':USDT';
                params = {
                    positionSide: direction.toUpperCase() // 'LONG' / 'SHORT'
                };
                side = isClose
                    ? (direction === 'long' ? 'sell' : 'buy')
                    : (direction === 'long' ? 'buy' : 'sell');
            }

            if (exchange.has['setLeverage']) {
                await exchange.setLeverage(leverage, formattedSymbol);
            }

            const order = await exchange.createOrder(
                formattedSymbol,
                type,
                side,
                amount,
                undefined,
                params
            );

            // console.log(`[ORDER] ${exchangeName} ${symbol} ${isClose ? 'close' : 'entry'}-${direction} ${amount} 成功`, order);
            return order;

        } catch (err) {
            console.error(`[ORDER-ERROR] ${exchangeName} ${symbol} ${isClose ? 'close' : 'entry'}-${direction} ${amount}`, err.message);
            return null;
        }
    }

    // 获取持仓（合约）
    async getPosition(exchangeName, symbol) {
        const exchange = this.exchanges[exchangeName];
        if (!exchange) throw new Error(`Unsupported exchange: ${exchangeName}`);
        if (!exchange.has.fetchPositions) return null;
        try {
            const positions = await exchange.fetchPositions([symbol]);
            return positions[0];
        } catch (err) {
            console.error(`[POSITION-ERROR] ${exchangeName} ${symbol}`, err.message);
            return null;
        }
    }

    // 获取余额
    async getBalance(exchangeName) {
        const exchange = this.exchanges[exchangeName];
        try {
            const balance = await exchange.fetchBalance();
            return balance.total;
        } catch (err) {
            console.error(`[BALANCE-ERROR] ${exchangeName}`, err.message);
            return null;
        }
    }
}

if (require.main === module) {
    const apiKeys = require('../config/exchangeApi.js'); // 请确保路径正确
    const executor = new TradeExecutor({
        apiKeys,
        proxy: require("../config/start.config.js").proxy || undefined
    });

    (async () => {
        const exchange = 'binance';
        const symbol = 'ARC/USDT';
        const isClose = false; // 为true时为平仓
        const direction = 'short'
        const amount = 70; // 小额数量，确保大于 minNotional

        console.log(`[TEST] 尝试下单 ${exchange} ${symbol} ${isClose} ${direction} ${amount}`);

        const order = await executor.placeOrder(exchange, symbol, isClose, direction, amount, 'market', 20);

        if (order) {
            console.log(`[TEST-SUCCESS] 订单成功:`);
        } else {
            console.error(`[TEST-FAIL] 订单失败`);
        }
    })();
}

module.exports = TradeExecutor;

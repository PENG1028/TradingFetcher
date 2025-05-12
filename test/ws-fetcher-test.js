const { CryptoSpotFetcher } = require('../core/fetchers/CryptoSpot.js');
const WebSocket = require('ws');
const HttpsProxyAgent = require('https-proxy-agent');
const fetch = require('node-fetch').default;

class ArbitrageMonitor {
    /*
    this.priceMap = {
        symbolA:{
            okx: {
                last: <最新成交价>,
                bidPx: <买一价>,
                askPx: <卖一价>,
                bidSz: <买一价 数量 USDT>,
                askSz: <卖一价订单量 USDT>
            },
            binance: {
                ...
            },
            spread: <spread>,
            absSpread: <absSpread>,
            spreadPctGross: <spreadPctGross>,
            spreadPctNet: <spreadPctNet>,
            direction: '[Long]OKX    |[Short]Binance',
            okxDirection: LONG | SHORT,
            binanceDirection: LONG | SHORT
        },
        symbolB:{
            ...
        },
        ...
    }
    */
    constructor({ fee = { okx: 0, binance: 0 }, onUpdate = null }) {
        this.fee = fee;
        this.onUpdate = onUpdate;
        this.sharedSymbols;
        this.agent = require("../config/start.config.js").proxy ? new HttpsProxyAgent(require("../config/start.config.js").proxy) : undefined;
        this.priceMap = {};
        this.ctValMap = {}; // e.g., { 'BTC/USDT': 0.01, ... }
        this.okxWS = null;      // 保存 OKX WebSocket 实例
        this.binanceWS = null;  // 保存 Binance WebSocket 实例
        this.reconnectInterval = 12 * 60 * 60 * 1000; // 12小时（毫秒）


        console.log(`[AM] 手续费设置: okx:${this.fee.okx} | binance:${this.fee.binance}`)
        this.startAutoUpdate();// 实时获取币种面值
    }

    // okx 合约 张 面值获取器
async updateCtValMap(retry = 3, delay = 2000) {
    for (let attempt = 1; attempt <= retry; attempt++) {
        try {
            const url = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
            const agent = this.agent;
            const res = await fetch(url, { agent });
            const json = await res.json();

            if (!json.data || !Array.isArray(json.data)) {
                throw new Error('[ctVal] OKX返回数据结构无效');
            }

            for (const inst of json.data) {
                const symbol = inst.instId.replace('-SWAP', '').replace('-', '/'); // 例: BTC/USDT
                this.ctValMap[symbol] = parseFloat(inst.ctVal);
            }

            console.log(`[ctVal] OKX面值更新完成，共计 ${Object.keys(this.ctValMap).length} 个合约`);
            return; // ✅ 成功就退出 retry 循环
        } catch (err) {
            console.error(`[ctVal] 第 ${attempt} 次获取失败: ${err.message}`);

            if (attempt < retry) {
                await new Promise(r => setTimeout(r, delay * attempt)); // ⏳ 增加延迟
            } else {
                console.error('[ctVal] 所有重试失败，等待下次定时器自动更新');
            }
        }
    }
}

    startAutoUpdate(intervalMs = 4 * 60 * 60 * 1000) {
        this.updateCtValMap(); // 首次立即拉取
        setInterval(this.updateCtValMap.bind(this), intervalMs);
    }



    // ✅ 通用重连控制器
    async manageConnection({ type, symbols, connectFn }) {
        let retryCount = 0;
        const maxRetryDelay = 60000; // 最大重试间隔 60s
        const reconnect = async () => {
            try {
                console.log(`[${type} WS] 开始重新连接...`);
                const newWS = await connectFn(symbols);
                // 先保留旧连接，确保新连接成功后再关闭
                const oldWS = this[`${type.toLowerCase()}WS`];
                if (oldWS) {
                    oldWS.removeAllListeners();
                    oldWS.close();
                }
                this[`${type.toLowerCase()}WS`] = newWS;
                retryCount = 0; // 重置重试计数器
            } catch (err) {
                console.error(`[${type} WS] 重连失败:`, err.message);
                // 指数退避重试（5s, 10s, 20s...，最大60s）
                const delay = Math.min(maxRetryDelay, 5000 * Math.pow(2, retryCount++));
                setTimeout(reconnect, delay);
            }
        };
        // 启动定时长线重连
        setInterval(reconnect, this.reconnectInterval);
        await reconnect(); // 首次连接
    }



    async getSymbols(exchangeId) {
        const config = require("../config/start.config.js")
        const fetcher = new CryptoSpotFetcher(exchangeId, {
            batchSize: 5,         // 覆盖默认配置
            symbols: [],
            quoteAsset: 'USDT',
            maxLiquidity: null,
            timeout: 30000,
            proxy: config.proxy, // 添加代理配置
            defaultType: 'swap'
        });

        await fetcher.loadAllSymbols()

        // ✅ 这里转换格式，例如 'BTC/USDT' => 'BTC-USDT'
        const Symbols = Array.from(fetcher.symbols).map(s => s);

        return Symbols
    }

    updateSpread (symbol) {
        const p = this.priceMap[symbol];
        if (!p?.okx || !p?.binance) return;
    
        const { okx, binance } = p;
    
        /* ---------- ① 仍按 last 价计算基础差值 ---------- */
        const spreadLast = binance.last - okx.last;                    // 正 = Bin 高于 OKX
        const avgLast    = (binance.last + okx.last) / 2 * 2;          // 买卖各 1 次
        const grossPct   = avgLast > 0 ? Math.abs(spreadLast / avgLast) * 100 : 0;
    
        p.spread         = spreadLast;
        p.absSpread      = Math.abs(spreadLast);
        p.spreadPctGross = grossPct;
        
    
        /* ---------- ② 仅 spreadPctNet 用 bid/ask 双向最优 ---------- */
        // A 向：买 OKX(ask) ‖ 卖 Binance(bid)
        const spreadA  = binance.bidPx - okx.askPx;
        const netPctA  = spreadA / ((binance.bidPx + okx.askPx) / 2) * 100
                         - (this.fee.okx + this.fee.binance);
    
        // B 向：买 Binance(ask) ‖ 卖 OKX(bid)
        const spreadB  = okx.bidPx - binance.askPx;
        const netPctB  = spreadB / ((okx.bidPx + binance.askPx) / 2) * 100
                         - (this.fee.okx + this.fee.binance);

        p.okxDirection = null;
        p.binanceDirection = null;
        if(netPctA>0){
            p.direction        = '[Long]OKX    |[Short]Binance'
            p.okxDirection     = "LONG"
            p.binanceDirection = "SHORT"
        }else{ 
            p.direction        = '[Long]Binance|[Short]OKX    '
            p.okxDirection     = "SHORT"
            p.binanceDirection = "LONG"
        }
        p.spreadPctNet = Math.max(netPctA, netPctB);   // 只存净收益更大的一边
    }
    

    /* ------------------------------------------------------------------
       OKX WebSocket：满足官方“30 s 无数据自动断开”要求的稳健实现
       - 订阅后 30 s 内若没收到任何数据 ⇒ 强制重连
       - 仅在 N 秒(25 s) 静默后才主动发送 'ping'，再等同样时长收 'pong'
    ------------------------------------------------------------------ */
    connectOKX(symbols) {
        // 1) 处理符号格式
        symbols = Array.from(symbols).map(s => s.replace('/', '-'));
        const wsURL        = 'wss://ws.okx.com:8443/ws/v5/public';

        // 2) 可调常量
        const MSG_TIMEOUT  = 25_000; // N < 30：静默多久后 ping
        const SUB_TIMEOUT  = 60_000; // 订阅 / 推送超时

        let backoff = 2_000;            // ☆ 指数退避
        let generation = 0;            // ☆ 连接代际

        let reconnectTimer;            // ☆ 防止多重 setTimeout
        const MAX_BACKOFF = 60_000;
        
        // 3) 内部状态
        let ws, lastMsgTimer, pingTimer, subTimer;   // ★ 新增 subTimer
        let subAck = false;

        // ---------- 辅助函数 ----------
        const safeSend = (payload) => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
        };

        // 每收到任意消息后重置静默计时
        const resetLastMsgTimer = () => {
            clearTimeout(lastMsgTimer);
            lastMsgTimer = setTimeout(sendPingIfIdle, MSG_TIMEOUT);
        };

        // 静默过长 ⇒ 先 ping 再等待 pong
        const sendPingIfIdle = () => {
            if (ws.readyState !== WebSocket.OPEN) return;

            console.log('[OKX WS] >> ping');
            safeSend(JSON.stringify({ op: 'ping' }));

            pingTimer = setTimeout(() => {
                console.warn('[OKX WS] pong 超时，重连...');
                restart();
            }, MSG_TIMEOUT);
        };

        // 统一清理 + 延迟 2 s 重连
        const restart = () => {
            clearTimeout(lastMsgTimer);
            clearTimeout(pingTimer);
            clearTimeout(subTimer);       // ☆ 新增

            // 尽力杀死旧连接
            try { ws.terminate(); } catch (_) {}

            // 防止重复排队
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, backoff);

            backoff = Math.min(backoff * 2, MAX_BACKOFF);
        };

        // ---------- 主连接 ----------
        const connect = () => {
            const myGen = ++generation;          // ☆ 本轮 id
            ws = new WebSocket(wsURL);

            ws.on('open', () => {
                console.log('[OKX WS] 已连接');

                const args = symbols.map(instId => ({
                    channel: 'tickers',
                    instId : `${instId}-SWAP`
                }));
                safeSend(JSON.stringify({ op: 'subscribe', args }));

                // 30 s 内必须有订阅确认或推送

                subAck = false;

                backoff = 2_000;  // ☆ 一旦成功握手就复位

                subTimer = setTimeout(() => {
                    if (!subAck) {
                        console.warn('[OKX WS] 订阅/推送超时，重连...');
                        restart();
                    }
                }, SUB_TIMEOUT);
            });

            ws.on('unexpected-response', (req, res) => {
                if (myGen !== generation) return;
                  console.error('[OKX WS] unexpected status', res.statusCode);
                  restart();
                });

            ws.on('message', (raw) => {
                if (myGen !== generation) return; // 忽略幽灵

                 // 👇 先把 raw 转成字符串
                 const text = raw.toString();

                // ---------- 心跳 ----------
                // 👇 再判断是否是 "pong" 文本
                if (text === 'pong') {
                    console.log('[OKX WS] << pong')
                    clearTimeout(pingTimer);
                    resetLastMsgTimer();
                    return;
                }

                // 👇 只有确定不是文本后再 parse
                const msg = JSON.parse(text);
                

                if (msg.event === 'subscribe' && msg.code === '0') {
                    subAck = true;
                    console.log('[OKX WS] 订阅成功');
                    clearTimeout(subTimer);          // ★ 已确认订阅，清掉超时定时
                    resetLastMsgTimer();
                    return;
                }

                // ---------- 行情数据 ----------
                if (msg.data && msg.data[0] && this.ctValMap) {
                    const d       = msg.data[0];
                    const instId  = msg.arg?.instId;
                    const symbol  = instId.replace('-SWAP', '').replace('-', '/');

                    if (!this.priceMap[symbol]) this.priceMap[symbol] = {};

                    const okxBidUSDT = d.bidPx * d.bidSz * this.ctValMap[symbol];
                    const okxAskUSDT = d.askPx * d.askSz * this.ctValMap[symbol];

                    this.priceMap[symbol].okx = {
                        last  : parseFloat(d.last),
                        bidPx : parseFloat(d.bidPx),
                        askPx : parseFloat(d.askPx),
                        bidSz : parseFloat(okxBidUSDT),
                        askSz : parseFloat(okxAskUSDT)
                    };
                    this.updateSpread(symbol);
                    clearTimeout(subTimer);          // ★ 首条行情也算合规推送

                    resetLastMsgTimer(); // 每条行情都刷新计时
                }
            });

            ws.on('close',  () => { 
                if (myGen !== generation) return;
                console.warn('[OKX WS] 连接关闭'); 
                restart(); });
            ws.on('error',  (e) => { 
                if (myGen !== generation) return;
                
                if (ws.readyState === WebSocket.OPEN) ws.close(); });
        };

        // ---------- 启动 ----------
        connect();
    }

    // ✅ Binance WebSocket 订阅（模拟指数价格）


    connectBinance(symbols) {
        // ✅ futures ⇒ fstream，spot ⇒ stream
         // ✅ 添加参数验证
    if (!symbols || !Array.isArray(symbols)) {
        console.error('[Binance WS] 无效的symbols参数:', symbols);
        throw new Error('必须提供有效的symbols数组');
    }
    
        const stream = symbols
            .map(s => [
                s.replace('/', '').toLowerCase() + '@bookTicker',      // ✅ ticker 包含 best bid/ask
                s.replace('/', '').toLowerCase() + '@miniTicker'      // ✅ depth5 逐档买卖五档（可选）
            ]).flat()
            .join('/');

        const url = `wss://fstream.binance.com/stream?streams=${stream}`
        const ws = new WebSocket(url, {
            agent: this.agent
        });
        let connected = false;                         // 标记

        ws.on('open', () => {
            connected = true;                     // ✅ 到这一步才算成功连接完成
            console.log('[Binance WS] 已连接');
        });

        ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            const streamType = msg.stream;
            const data = msg.data;

            if (streamType.endsWith('@bookTicker')) {
                // 获取币安挂单 USDT 量 (默认为 币本位)
                const symbol = data.s.replace('USDT', '/USDT');

                const binanceBidUSDT = data.b * data.B; // bidPx * bidSz
                const binanceAskUSDT = data.a * data.A;

                if (!this.priceMap[symbol]) this.priceMap[symbol] = {};
                this.priceMap[symbol].binance = {
                    ...this.priceMap[symbol]?.binance,
                    bidPx: parseFloat(data.b),
                    askPx: parseFloat(data.a),
                    bidSz: binanceBidUSDT,
                    askSz: binanceAskUSDT
                };
                // 把第一次计算推迟到 last 写⼊后。或者把 @miniTicker 放前⾯更新 last
                if (this.priceMap[symbol]?.binance?.last) this.updateSpread(symbol);
                
            } else if (streamType.endsWith('@miniTicker')) {
                const symbol = data.s.replace('USDT', '/USDT');  // 提取 symbol
                // ✅ 处理最新成交价
                if (!this.priceMap[symbol]) this.priceMap[symbol] = {};
                
                this.priceMap[symbol].binance = {
                    ...this.priceMap[symbol]?.binance,
                    last: parseFloat(data.c)
                };
                this.updateSpread(symbol);
            }
        });

        // ✅ 监听 ping 帧（低层 WebSocket PING，不是 JSON）
        ws.on('ping', (data) => {
            console.log('[Binance WS] << ping');
            ws.pong(data);  // ✅ 必须回应 pong，并带上同样 payload（或空）
            console.log('[Binance WS] >> pong');
        });


        ws.on('error', err => {if (ws.readyState === WebSocket.OPEN) ws.close();});
        ws.on('close', () => {
            console.warn('[Binance] WS closed');
            clearInterval(this.listenKeyRenewTimer);

            if (!connected) {
                console.warn('[Binance-fetcher] 首次连接尚未完成就断开，稍后重连');
            }
        
            console.log('[Binance] ws reconnect start');
            this.manageConnection({
                type: 'binance',
                symbols: this.sharedSymbols,
                connectFn: this.connectBinance.bind(this)
            });

            /* 已经连过—> 交给上层的自动重连 */
            console.log('[Binance] ws reconnet start')

            this.manageConnection({
                type: 'binance',
                symbols: this.sharedSymbols,
                connectFn: this.connectBinance.bind(this)
            });
        });
    }

    async start(symbols) {
        this.sharedSymbols = null;
        if (Array.isArray(symbols) && symbols.length > 0) {
            // ✅ 传入了指定 symbols，直接使用
            this.sharedSymbols = symbols;
        } else {
            // ⛳ 否则自动拉取并计算交集
            const [okxSymbols, binanceSymbols] = await Promise.all([
                this.getSymbols('okx'),
                this.getSymbols('binance')
            ]);
            this.sharedSymbols = okxSymbols.filter(sym => binanceSymbols.includes(sym));
        }

        // 并行管理两个连接
        await Promise.all([
            this.manageConnection({
                type: 'OKX',
                symbols: this.sharedSymbols,
                connectFn: this.connectOKX.bind(this)
            }),
            this.manageConnection({
                type: 'Binance',
                symbols: this.sharedSymbols,
                connectFn: this.connectBinance.bind(this)
            })
        ]);
    }

    getPriceMap() {

        const cloneDeep = obj => JSON.parse(JSON.stringify(obj)); // 简单深拷贝

        const cleanMap = {};

        for (const [symbol, data] of Object.entries(this.priceMap)) {
            if (
                data.okx && typeof data.okx.last === 'number' &&
                data.binance && typeof data.binance.last === 'number' &&
                typeof data.spreadPctNet === 'number'
            ) {
                cleanMap[symbol] = cloneDeep(data);
            }
        }

        return cleanMap;
    }


}

// ✅ 启动函数
async function test() {

    const okxFee = 0.005;
    const binanceFee = 0.005;
    const fee = {
        okx: okxFee,
        binance: binanceFee
    }

    const AM = new ArbitrageMonitor({ fee });
    const testSymbols = ['ETH/USDT']
    AM.start(testSymbols);
    setInterval(() => {
        
        const table = Object.entries(AM.getPriceMap())
            .filter(([_, p]) => p.okx.last && p.binance.last && p.spreadPctNet !== null)
            .map(([symbol, p]) => ({
                symbol,
                okx_last: p.okx.last,
                okx_bid: p.okx.bidPx,
                okx_ask: p.okx.askPx,
                binance_last: p.binance.last,
                binance_bid: p.binance.bidPx,
                binance_ask: p.binance.askPx,
                absSpread: p.absSpread?.toFixed(6),
                grossPct: p.spreadPctGross?.toFixed(6) + '%',
                netPct: p.spreadPctNet?.toFixed(6) + '%',
                direction: p.direction
            }))
            .sort((a, b) => parseFloat(b.netPct) - parseFloat(a.netPct))  // 净收益率降序
            .slice(0, 10);

        if (table.length > 0) {
            console.clear();
            console.table(table);  // ✅ 表格形式展示前 10 名
        }
    }, 500);
}
if (require.main === module) {
    test();
}
module.exports = ArbitrageMonitor;

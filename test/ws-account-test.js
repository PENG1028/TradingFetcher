// AccountMonitor.js
// ------------------------------------------------------------
// WebSocket-based account & position monitor for OKX + Binance
// ------------------------------------------------------------
// ✓ Stand‑alone runnable (node AccountMonitor.js) for quick tests
// ✓ Can be imported by other modules (e.g. TradingControl) as:
//      const AccountMonitor = require('./AccountMonitor.js');
//      const am = new AccountMonitor({ okx:{...}, binance:{...} });
//      am.start();
// ✓ Exposes unified `balance` & `positions` compatible with
//   tradingsimulatorSystem.js so you can seamlessly switch from
//   paper‑trade to live‑trade without refactoring existing logic.
// ------------------------------------------------------------

/* eslint-disable camelcase */
const crypto = require('crypto');
const WebSocket = require('ws');
const fetch = require('node-fetch').default;
const HttpsProxyAgent = require('https-proxy-agent');

const OKX_WS_URL_PRIVATE = 'wss://ws.okx.com:8443/ws/v5/private';
const BINANCE_FUTURES_REST = 'https://fapi.binance.com';
const BINANCE_FUTURES_WS_ROOT = 'wss://fstream.binance.com/ws';

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

class AccountMonitor {
    /**
     * @param {Object}   cfg
     * @param {Object}   cfg.okx      – { apiKey, secret, passphrase }
     * @param {Object}   cfg.binance  – { apiKey, secret }
     * @param {String}   [cfg.proxy]  – optional http/https proxy URL
     * @param {Function} [cfg.onUpdate] – callback(state) on any update
     */
    /*
|--------------------------------------------------------------------------
| 🧠 核心数据结构说明（AccountMonitor 架构）
|--------------------------------------------------------------------------
| 所有交易账户状态统一封装在以下 3 个成员变量中，便于回测/实盘统一调度：
|
|   - balance       → 每个平台当前可用资金（USDT）
|   - positions     → 当前所有持仓（symbol: 持仓详情）
|   - snapshotLog   → 每一次成交记录 + 快照（构建完整资金曲线）
|
| 这些结构与 tradingsimulatorSystem.js 保持一致，支持快速在模拟与实盘切换。
|--------------------------------------------------------------------------
*/

    /**
     * this.balance
     * ------------------------------------------------------------
     * 存储每个平台的 USDT 可用余额（周期性轮询或事件驱动更新）
     * {
     *   okx:    2134.25,     // 当前 OKX 合约账户可用 USDT
     *   binance: 512.67      // 当前 Binance 合约账户可用 USDT
     * }
     */

    /**
     * this.positions
     * ------------------------------------------------------------
     * 存储当前所有未平仓仓位（只记录非空仓，平仓自动清除）
     * 每个平台一个对象，以 symbol 为 key
     * {
     *   okx: {
     *     'BTC/USDT': {
     *        symbol: 'BTC/USDT',
     *        direction: 'LONG' | 'SHORT',
     *        entryPrice: 28000,
     *        currentPrice: 28500,
     *        qty: 0.01,
     *        margin: 14.0,
     *        positionValue: 285.0,
     *        fee: 0,
     *        ts: 1684299000000      // 最后更新时间戳
     *     },
     *     ...
     *   },
     *   binance: { ... 同结构 ... }
     * }
     */

    /**
     * this.snapshotLog
     * ------------------------------------------------------------
     * 存储所有成交记录（tick 级）+ 当时资金快照，支持回放 / 策略分析
     * 每个对象结构如下：
     * {
     *   ts      : 1684299000000,      // 成交时间戳（毫秒）
     *   exchange: 'okx' | 'binance',  // 平台
     *   symbol  : 'BTC/USDT',
     *   posSide  : 'LONG' | 'SHORT',
     *   side    : 'ENTRY' | 'EXIT',
     *   qty     : 0.01,
     *   price   : 28000,
     *   fee     : 0.12,               // 成交手续费（USDT）
     *   pnl     : -1.45,              // 已实现盈亏（USDT），Binance 无则为 0
     *   balance : {
     *     okx: 2120.88,
     *     binance: 500.33
     *   }
     * }
     */

    constructor({ okx, binance, proxy = null, onUpdate = null, lev = 10, mgnMode = 'cross' }) {
        if (!okx || !binance) {
            throw new Error('okx & binance credentials are both required');
        }
        this.mgnMode = mgnMode;
        this.defLev = lev;
        this.okxCred = okx;
        this.binanceCred = binance;
        this.agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
        this.onUpdate = onUpdate;

        this.okxCtValMap = {}; // symbol -> ctVal 映射
        /*
          Unified runtime state – structure mirrors tradingsimulatorSystem.js
        */
        this.balance = {
            okx: 0,        // USDT wallet balance
            binance: 0
        };
        this.positions = {
            okx: {},       // symbol -> position obj
            binance: {}
        };
        this.snapshotLog = [];

        // Internal handles & timers
        this.okxWS = null;
        this.binanceWS = null;
        this.okxReconnectTimer = null;
        this.binanceReconnectTimer = null;
        this.reconnectInterval = 12 * 60 * 60 * 1_000; // 12h hard‑reconnect

        // Binance listen‑key management
        this.listenKey = null;
        this.listenKeyRenewTimer = null;
        this.binanceTimeDelta = 0;
        this.snapshotTimer = null; // ✔ 用于 Binance 账户轮询

    }

    /* =========================================================
     * PUBLIC APIs
     * =======================================================*/
    async start() {
        await this._syncBinanceTime();
        await this.fetchOkxContractValueMap();

        // ✅ 保证不重复设置
        if (this.snapshotTimer) clearInterval(this.snapshotTimer);
        this.snapshotTimer = setInterval(() => {
            this._snapshotBinanceAccount().catch(console.error);
        }, 15_000);

        await Promise.all([
            this._manageConnection({ type: 'OKX', connectFn: this._connectOKX.bind(this) }),
            this._manageConnection({ type: 'BINANCE', connectFn: this._connectBinance.bind(this) })
        ]);
        // console.log(this.balance)
        // console.log(this.positions)
        // console.log(this.snapshotLog)
    }

    /** Deep‑copy current state */
    getState() {
        // console.log(this.balance)
        // console.log(this.positions)
        // console.log(this.snapshotLog)
        return {
            balance: structuredClone(this.balance),
            positions: structuredClone(this.positions),
            snapshotLog: structuredClone(this.snapshotLog)
        };
    }

    getAccountMap() { return this.getState(); }

    /* =========================================================
     * Connection manager – generic wrapper shared by both exchanges
     * =======================================================*/
    async _manageConnection({ type, connectFn }) {

        console.log(`[manage] try connect ${type}`);
        let retry = 0;
        const MAX_BACKOFF = 60_000;

        const reconnect = async () => {
            try {
                connectFn();
                retry = 0; // success → reset backoff
            } catch (err) {
                console.error(`[${type}] connect error:`, err.message);
                retry += 1;
                const delay = Math.min(MAX_BACKOFF, 5_000 * 2 ** retry);
                setTimeout(reconnect, delay);
            }
        };

        // kick off + periodic hard‑reset
        await reconnect();
        setInterval(async () => {
            console.log(`[${type}] scheduled 12h reconnect`);
            await reconnect();
        }, this.reconnectInterval);
    }

    /* =========================================================
     * OKX PRIVATE WebSocket
     * =======================================================*/
    async fetchOkxContractValueMap() {
        try {
            const url = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
            const res = await fetch(url, { agent: this.agent });
            const json = await res.json();
            if (!json.data) throw new Error('Empty OKX instruments');

            for (const inst of json.data) {
                const symbol = inst.instId.replace('-SWAP', '').replace('-', '/'); // eg: BTC/USDT
                this.okxCtValMap[symbol] = parseFloat(inst.ctVal); // eg: 0.01
            }

            console.log(`[OKX] 合约面值 ctVal 映射更新完成，共 ${Object.keys(this.okxCtValMap).length} 项`);
        } catch (err) {
            console.error('[OKX] 获取合约面值失败:', err.message);
        }
    }

    async _connectOKX() {
        return new Promise((resolve, reject) => {

            // 2) 可调常量
            const MSG_TIMEOUT = 25_000;      // idle → ping
            const SUB_TIMEOUT = 60_000;      // login/subscribe / first push
            const MAX_BACKOFF = 60_000;
            let backoff = 2_000;
            let generation = 0;
            let firstSnapshot = false;       // resolve once account received
            let reconnectTimer;

            // 3) 内部状态
            let ws, lastMsgTimer, pingTimer, subTimer;
            let subAck = false;


            const safeSend = p => { if (ws?.readyState === WebSocket.OPEN) ws.send(p); };
            const resetLastMsgTimer = () => {
                clearTimeout(lastMsgTimer);
                lastMsgTimer = setTimeout(sendPingIfIdle, MSG_TIMEOUT);
            };
            const sendPingIfIdle = () => {
                if (ws.readyState !== WebSocket.OPEN) return;

                safeSend('ping');
                console.log('[OKX WS] >> ping');
                pingTimer = setTimeout(() => {
                    console.warn('[OKX] pong timeout');
                    restart();
                }, MSG_TIMEOUT);
            };

            const restart = () => {
                /* 已经连过—> 交给上层的自动重连 */
                console.log('[OKX] ws reconnect start')

                clearTimeout(lastMsgTimer);
                clearTimeout(pingTimer);
                clearTimeout(subTimer);
                try { ws.terminate(); } catch (_) {/*noop*/ }
                clearTimeout(reconnectTimer);

                reconnectTimer = setTimeout(connect, backoff);

                backoff = Math.min(backoff * 2, MAX_BACKOFF);
            };

            const connect = () => {
                const myGen = ++generation; // ☆ 本轮 id
                ws = new WebSocket(OKX_WS_URL_PRIVATE, { agent: this.agent });

                ws.on('open', () => {
                    console.log('[OKX] WS opened');

                    this.okxWS = ws;

                    backoff = 2_000;  // ☆ 一旦成功握手就复位

                    // ---- login
                    const ts = (Date.now() / 1000).toString();

                    const sign = crypto.createHmac('sha256', this.okxCred.secret)
                        .update(ts + 'GET' + '/users/self/verify')
                        .digest('base64');

                    const login =
                    {
                        op: 'login',
                        args: [{
                            apiKey: this.okxCred.apiKey,
                            passphrase: this.okxCred.passphrase,
                            timestamp: ts,
                            sign
                        }]
                    };

                    safeSend(JSON.stringify(login));
                    // set subscribe timeout (will be reset after login & subs)

                    subAck = false;


                    subTimer = setTimeout(() => {
                        if (!subAck) {
                            console.warn('[OKX] login/subscribe timeout');
                            restart();
                        }
                    },

                        SUB_TIMEOUT);
                });

                ws.on('unexpected-response', (_, res) => {
                    if (myGen !== generation) return;
                    console.error('[OKX] unexpected', res.statusCode);
                    restart();
                });

                ws.on('message', raw => {
                    if (myGen !== generation) return;

                    // 👇 先把 raw 转成字符串
                    const text = raw.toString();

                    /* ---- heartbeat ---- */
                    // 👇 再判断是否是 "pong" 文本
                    if (text === 'pong') {
                        console.log('[OKX WS] << pong')
                        clearTimeout(pingTimer);
                        resetLastMsgTimer();
                        return;
                    }

                    // 👇 只有确定不是文本后再 parse
                    const msg = JSON.parse(text);

                    if (msg.event === 'subscribe' && msg.arg?.channel === 'balance_and_position') {
                        subAck = true;
                        clearTimeout(subTimer);
                        console.log('[OKX] subscribe success');
                        resetLastMsgTimer();
                        return;
                    }


                    if (msg.event === 'login' && msg.code === '0') {
                        subAck = true;

                        console.log('[OKX] login success');

                        clearTimeout(subTimer);


                        safeSend(JSON.stringify({
                            op: 'subscribe',
                            args: [
                                { channel: 'balance_and_position' },
                                { channel: 'orders', instType: 'ANY' }
                            ]
                        }));

                        subTimer = setTimeout(() => {
                            console.warn('[OKX] subscribe timeout');
                            restart();
                        }
                            , SUB_TIMEOUT
                        );

                        resetLastMsgTimer(); return;
                    }

                    /* ---- data ---- */
                    if (msg.arg?.channel === 'balance_and_position' && Array.isArray(msg.data)) {
                        this._handleOkxBalPos(msg.data[0]);
                        if (!firstSnapshot && msg.data[0]?.eventType === 'snapshot') {

                            firstSnapshot = true;
                            resolve();              // ✅ Promise 完成，_manageConn ↪︎ start() 不会卡住
                        }
                        resetLastMsgTimer();
                    }

                    if (msg.arg?.channel === 'orders' && Array.isArray(msg.data)) {

                        for (const o of msg.data) {
                            // ✅ 条件 1：订单状态必须是 filled
                            if (o.state !== 'filled') continue;

                            // ✅ 条件 2：有真实成交数量
                            if (!o.fillSz || parseFloat(o.fillSz) === 0) continue;


                            const symbol = o.instId.replace('-SWAP', '').replace('-', '/');

                            const side = o.posSide.toUpperCase() === 'LONG'
                                ? o.side.toUpperCase() === 'BUY' ? 'ENTRY' : 'EXIT'
                                : o.side.toUpperCase() === 'BUY' ? 'EXIT' : 'ENTRY';


                            this._recordTrade({
                                exchange: 'okx',
                                symbol,
                                posSide: o.posSide.toUpperCase(),               // LONG / SHORT
                                side,                 // ENTRY / EXIT
                                qty: Math.abs(parseFloat(o.fillSz)),
                                price: parseFloat(o.fillPx),
                                fee: Math.abs(parseFloat(o.fee)),
                                pnl: parseFloat(o.pnl)
                            });
                        }
                        this._snapshotOkxBalanceOnly()//更新余额

                        resetLastMsgTimer();
                        return;
                    }


                    resetLastMsgTimer(); // 每次都刷新计时
                });

                ws.on('close', code => {
                    if (myGen !== generation) return;


                    console.warn('[OKX] closed', code);
                    restart();
                });
                ws.on('error', e => {
                    if (myGen !== generation) return;

                    if (ws.readyState === WebSocket.OPEN) ws.close();
                });
            };
            // kick‑off
            connect();
        });
    }

    async _snapshotOkxBalanceOnly() {
        try {
            const ts = Date.now().toString();
            const method = 'GET';
            const path = '/api/v5/account/balance';
            const sign = crypto.createHmac('sha256', this.okxCred.secret)
                .update(ts + method + path)
                .digest('base64');

            const res = await fetch(`https://www.okx.com${path}`, {
                method,
                headers: {
                    'OK-ACCESS-KEY': this.okxCred.apiKey,
                    'OK-ACCESS-PASSPHRASE': this.okxCred.passphrase,
                    'OK-ACCESS-TIMESTAMP': ts,
                    'OK-ACCESS-SIGN': sign
                },
                agent: this.agent
            });
            const json = await res.json();
            const usdt = (json.data?.[0]?.details || []).find(b => b.ccy === 'USDT');
            if (usdt) {
                this.balance.okx = parseFloat(usdt.availEq);
            }
            this._notify();
        } catch (err) {
            console.error('[OKX] balance poll err', err.message);
        }
    }

    // 统一处理函数
    _handleOkxBalPos(packet) {
        /* ---------- 余额 ---------- */
        const usdt = (packet.balData || []).find(b => b.ccy === 'USDT');
        if (usdt) this.balance.okx = parseFloat(usdt.cashBal);

        /* ---------- 持仓 ---------- */
        for (const p of packet.posData || []) {
            const symbol = p.instId.replace('-SWAP', '').replace('-', '/');
            const rawPos = Math.abs(parseFloat(p.pos)); // 张数
            const ctVal = this.okxCtValMap?.[symbol] || 1;
            const qty = rawPos * ctVal; // ✅ 真实币种单位
            if (qty === 0) {
                delete this.positions.okx[symbol];
                continue;
            }

            const dir = p.posSide === 'long' ? 'LONG' : 'SHORT';
            const entry = parseFloat(p.avgPx);
            const lev = parseFloat(this.defLev);
            const margin = Math.abs(qty * entry) / lev;

            this.positions.okx[symbol] = {
                symbol,
                direction: dir,
                entryPrice: entry,
                currentPrice: entry,
                qty,
                positionValue: entry * qty,
                margin,
                fee: 0, // 仓位不计算手续费
                ts: Date.now()
            };

        }

        this._notify();           // 统一派发回调
    }



    /* =========================================================
     * BINANCE Futures user‑data stream (ACCOUNT_UPDATE + POSITION)   
     * ================
     * =======================================*/
    async _connectBinance() {


        if (this.binanceWS && this.binanceWS.readyState === WebSocket.OPEN) {
            console.warn('[Binance] 重连请求忽略，已有连接');
            return;
        }

        {

            /* ----------------------------  PATCH ①  ---------------------------- */
            let noMsgTimeout = null;
            let backoff = 2_000;               // 指数退避
            const MAX_BACKOFF = 60_000;
            /* --------------------------  PATCH END  --------------------------- */
            await this._syncBinanceTime();
            // 1)  create / renew listenKey via REST
            this.listenKey = await this._createListenKey();
            // 2)  open WS
            const url = `${BINANCE_FUTURES_WS_ROOT}/${this.listenKey}`;
            const ws = new WebSocket(url, { agent: this.agent });

            this.binanceWS = ws;
            let connected = false;                         // 标记


            ws.on('open', () => {
                this._snapshotBinanceAccount();
            });

            ws.on('ping', (data) => {
                console.log('[Binance WS] >> ping');
                ws.pong(data);
                console.log('[Binance WS] << pong');
            });

            ws.on('message', (raw) => {
                const payload = JSON.parse(raw);
                // console.log('-->', payload.e);
                if (payload.e === 'ACCOUNT_UPDATE') {
                    this._handleBinanceAccountUpdate(payload);
                }

                if (payload.e === 'ORDER_TRADE_UPDATE') {
                    const o = payload.o;            // 订单对象
                    if (o.x !== 'TRADE') return;  // ✅ 小写 x，判断是否是有成交的推送


                    let posSide = o.ps.toUpperCase();
                    let side = o.S.toUpperCase();

                    if (posSide === 'LONG') {
                        side = side === 'BUY' ? 'ENTRY' : 'EXIT';
                    } else if (posSide === 'SHORT') {
                        side = side === 'SELL' ? 'ENTRY' : 'EXIT';
                    }


                    const symbol = o.s.replace('USDT', '/USDT');
                    this._recordTrade({
                        exchange: 'binance',
                        symbol,
                        posSide,              // LONG / SHORT
                        side,                    // ENTRY / EXIT
                        qty: Math.abs(parseFloat(o.l)),
                        price: parseFloat(o.ap || o.L),
                        fee: Math.abs(parseFloat(o.n)),
                        pnl: parseFloat(o.rp)                       // Binance 不直接推 realized PnL
                    });

                    this._snapshotBinanceBalanceOnly() //获取余额

                    return;
                }


            });

            ws.on('message', () => {
                clearTimeout(noMsgTimeout);
                noMsgTimeout = setTimeout(() => {
                    console.warn('[Binance WS] 无消息超时，主动重连...');
                    ws.terminate();
                }, 30000);
            });

            ws.on('close', () => {
                console.warn('[Binance] WS closed');

                clearInterval(this.listenKeyRenewTimer);

                

                // 主动触发一次重连（与 error 分支保持一致）
                const delay = backoff;
                backoff = Math.min(backoff * 2, MAX_BACKOFF);
                setTimeout(() => this._connectBinance().catch(console.error), delay);
            });

            ws.on('error', (err) => {
                console.error('[Binance] WS error', err.message);
                if (ws.readyState === WebSocket.OPEN) ws.close();


                /* ----------------------------  PATCH ③ ---------------------------- */
                // 内部自愈重连（不会再调用 _manageConnection，避免多重连接）
                const delay = backoff;
                backoff = Math.min(backoff * 2, MAX_BACKOFF); // 指数退避
                setTimeout(() => this._connectBinance()       // ↻ 递归重连
                    .catch(console.error), delay);
                /* --------------------------  PATCH END --------------------------- */

            });


            // 3)  schedule listen‑key keep‑alive every 30 min
            this.listenKeyRenewTimer = setInterval(() => this._keepAliveListenKey(), 30 * 60 * 1_000);
        };
    }

    async _syncBinanceTime() {
        try {
            const res = await fetch(`${BINANCE_FUTURES_REST}/fapi/v1/time`, { agent: this.agent });
            const { serverTime } = await res.json();
            this.binanceTimeDelta = serverTime - Date.now();
            console.log('[Binance] 时间差 Δt =', this.binanceTimeDelta, 'ms');
            this.binanceTimeDelta = serverTime - Date.now();/*  */
            this._lastTimeSync = Date.now();          // ★
        } catch (e) {
            console.warn('[Binance] 获取服务器时间失败');
            this.binanceTimeDelta = 0;
        }
    }


    async _snapshotBinanceAccount() {

        // ... fetch json ...
        const newPos = {};                 // ← 新建临时表

        const endpoint = '/fapi/v2/account';

        const now = Date.now();
        if (now - this._lastTimeSync > 10 * 60_000) {     // 10 min 重新同步
            await this._syncBinanceTime();
        }
        const ts = now + this.binanceTimeDelta;

        const query = `timestamp=${ts}&recvWindow=10000`;  // 👈 多加 recvWindow 提高容错

        const sig = crypto.createHmac('sha256', this.binanceCred.secret)
            .update(query)
            .digest('hex');

        const url = `${BINANCE_FUTURES_REST}${endpoint}?${query}&signature=${sig}`;
        const res = await fetch(url, {
            headers: { 'X-MBX-APIKEY': this.binanceCred.apiKey },
            agent: this.agent
        });
        const json = await res.json();

        if (!json || !Array.isArray(json.assets)) {
            console.warn('[Binance] 返回数据无 assets 字段或格式错误：', JSON.stringify(json));
            return;
        }

        // 余额
        const usdt = json.assets.find(a => a.asset === 'USDT');
        if (usdt) this.balance.binance = parseFloat(usdt.walletBalance);

        // 持仓
        for (const p of json.positions) {
            const qty = parseFloat(p.positionAmt);
            if (qty === 0) continue;
            const symbol = p.symbol.replace('USDT', '/USDT');
            const dir = qty > 0 ? 'LONG' : 'SHORT';
            const entry = parseFloat(p.entryPrice);
            const lev = parseFloat(this.defLev);
            const margin = Math.abs(qty * entry) / lev;

            newPos[symbol] = {
                symbol,
                direction: dir,
                entryPrice: entry,
                currentPrice: entry,
                qty: Math.abs(qty),
                positionValue: Math.abs(entry * qty),
                margin,
                fee: 0,
                ts: Date.now()
            };
        }

        // ✅ 一次性替换，自动清掉 0 仓位
        this.positions.binance = newPos;

        this._notify();
    }

    async _snapshotBinanceBalanceOnly() {
        const endpoint = '/fapi/v2/balance';
        const ts = Date.now() + this.binanceTimeDelta;
        const query = `timestamp=${ts}&recvWindow=10000`;  // ✅ 加上 recvWindow 和 Δt 校正
        const sig = crypto.createHmac('sha256', this.binanceCred.secret)
            .update(query).digest('hex');
        const url = `${BINANCE_FUTURES_REST}${endpoint}?${query}&signature=${sig}`;
        try {
            const res = await fetch(url, {
                headers: { 'X-MBX-APIKEY': this.binanceCred.apiKey },
                agent: this.agent
            });
            const json = await res.json();
            const usdt = json.find(a => a.asset === 'USDT');
            if (usdt) {
                this.balance.binance = parseFloat(usdt.balance);
            }
            this._notify();
        } catch (err) {
            console.error('[Binance] balance poll err', err.message);
        }
    }



    async _createListenKey() {
        try {
            const res = await fetch(`${BINANCE_FUTURES_REST}/fapi/v1/listenKey`, {
                method: 'POST',
                headers: {
                    'X-MBX-APIKEY': this.binanceCred.apiKey
                },
                agent: this.agent
            });
            if (!res.ok) {
                throw new Error(`createListenKey failed: ${res.status}`);
            }
            const json = await res.json();
            return json.listenKey;
        } catch (err) {
            console.error('[Binance] 获取 listenKey 失败:', err.message);
            throw err; // rethrow 让上层继续处理
        }
    }

    async _keepAliveListenKey() {
        if (!this.listenKey) return;
        await fetch(`${BINANCE_FUTURES_REST}/fapi/v1/listenKey`, {
            method: 'PUT',
            headers: {
                'X-MBX-APIKEY': this.binanceCred.apiKey
            },
            agent: this.agent
        });
        console.log('[Binance] listenKey keep‑alive sent');
    }

    _handleBinanceAccountUpdate(payload) {

        // Balance array
        const usdtBal = (payload.a.B || []).find((b) => b.a === 'USDT');
        if (usdtBal) {
            this.balance.binance = parseFloat(usdtBal.wb);
        }

        // Positions
        for (const p of payload.a.P || []) {
            const symbolRaw = p.s; // e.g. BTCUSDT
            const symbol = symbolRaw.replace('USDT', '/USDT');
            const qty = parseFloat(p.pa);
            if (qty === 0) {
                delete this.positions.binance[symbol];
                continue;
            }
            const direction = qty > 0 ? 'LONG' : 'SHORT';
            const entryPrice = parseFloat(p.ep);
            const leverage = parseFloat(this.defLev);

            if (!entryPrice || !leverage || entryPrice <= 0 || leverage <= 0) {
                console.warn(`[BINANCE][${symbol}] 无效持仓数据 entry=${entryPrice} lev=${leverage}，跳过`);

                continue;
            }
            const margin = Math.abs(qty * entryPrice) / leverage;
            this.positions.binance[symbol] = {
                symbol,
                direction,
                entryPrice,
                currentPrice: entryPrice,
                qty: Math.abs(qty),
                positionValue: Math.abs(entryPrice * qty),
                margin,
                fee: 0,
                ts: Date.now()
            };

        }
        this._notify();
    }

    _recordTrade({ exchange, symbol, posSide, side, qty, price, fee = 0, pnl = 0 }) {
        this.snapshotLog.push({
            ts: Date.now(),
            exchange,
            symbol: symbol || 'UNKNOWN',
            posSide: posSide || 'UNKNOWN',
            side: side || 'UNKNOWN',
            qty: isNaN(qty) ? 0 : qty,
            price: isNaN(price) ? 0 : price,
            fee: Math.abs(isNaN(fee) ? 0 : fee),
            pnl: isNaN(pnl) ? 0 : pnl,
            balance: deepClone(this.balance),
            invalid: !symbol || !side || isNaN(qty) || isNaN(price)
        });
    }


    /* =========================================================
     * INTERNAL utility
     * =======================================================*/
    _notify() {
        if (typeof this.onUpdate === 'function') {
            this.onUpdate(this.getState());
        }
    }
}

/* ------------------------------------------------------------------
 * ────────── Example: quick CLI view ──────────
 *   $ OKX_KEY=... OKX_SECRET=... OKX_PASSPHRASE=... \
 *     BIN_KEY=... BIN_SECRET=... node AccountMonitor.js
 * ----------------------------------------------------------------*/
if (require.main === module) {
    const monitor = new AccountMonitor({
        okx: require("../config/exchangeApi.js").okx,
        binance: require("../config/exchangeApi.js").binance,
        proxy: require("../config/start.config.js").proxy ? require("../config/start.config.js").proxy : undefined,
        onUpdate: (state) => {

            console.clear();

            // 💰 当前余额
            console.log('💰  Balances');
            console.table([
                { Exchange: 'okx', USDT: state.balance.okx },
                { Exchange: 'binance', USDT: state.balance.binance }
            ]);

            // 📌 当前持仓（不含 currentPrice 字段）
            const rows = [];
            for (const ex of ['okx', 'binance']) {
                for (const p of Object.values(state.positions[ex])) {
                    const { currentPrice, ...rest } = p; // ✂️ 去掉 currentPrice
                    rows.push({ Exchange: ex, ...rest });
                }
            }

            if (rows.length) {
                console.log('\n📌  Positions');
                console.table(rows);
            } else {
                console.log('\n📌  No open positions');
            }

            // 🧾 历史成交记录（snapshotLog）
            const log = state.snapshotLog?.slice?.() || [];
            const cleanlog = log.filter(entry => !entry.invalid);
            if (cleanlog.length) {
                console.log('\n🧾  Trade History');
                console.table(log.map(entry => ({
                    Time: new Date(entry.ts).toLocaleTimeString(),
                    Ex: entry.exchange,
                    Symbol: entry.symbol,
                    PosSide: entry.posSide,
                    Side: entry.side,
                    Qty: entry.qty,
                    Price: entry.price,
                    Fee: entry.fee,
                    PnL: entry.pnl,
                    Bal_OKX: entry.balance.okx,
                    Bal_BIN: entry.balance.binance
                })));
            }
        }
    });
    monitor.start();
}

module.exports = AccountMonitor;

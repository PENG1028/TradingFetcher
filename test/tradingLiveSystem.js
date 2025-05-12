
const ArbitrageMonitor = require('./ws-fetcher-test.js');
const AccountMonitor = require('./ws-account-test.js');
const TradeExecutor = require('./traderExecutor.js');
const MinOrderChecker = require('./minOrderUsdtChecker.js')

class TradingControl {
    /*
    this.positions = {
        exchangeA:{
            'BTC/USDT': {
                symbol: <>,
                direction: <>,
                entryPrice: <>,
                currentPrice: <>,
                qty: <by symbol>,
                positionValue: <>,
                margin: marginUSDT,
                fee:,
                ts: <>
            },
            SYMBOL2 : {...},
            ... 
        },
        exchangeB:{ ... },,
        ... 
    }

    this.positionMeta = {
        [symbol]: {
            ts: <timestamp>,              // 开仓时间
            initialNetPct: <number>      // 初始净收益率
        },
        ...
    };
    */
    static LEG_GRACE_MS = 1500;         // 建仓后允许账户同步的缓冲期
    constructor(module = 'simulat', view = true, fee = { okx: 0.001, binance: 0.001 }) {

        this.DEFAULT_ENTRY_LEVERAGE = 20

        this.pairPending = {};          // symbol -> firstLegTimestamp

        this.refreshInterval = 200;// ms
        this.viewModule = view;

        this.arbitrageMonitor;

        this.tradingData;
        this.accountData = { balance: {}, positions: {}, snapshotLog: {} };  // ← 新增;

        this.positions = {};
        this.arbitrageHistory = [];
        this.exitHistory = [];
        this.entryHistory = [];
        this.tradingHistory = [];
        this.ordering = {
            okx: {
                entry: {},
                exit: {},
            },
            binance: {
                entry: {},
                exit: {},
            }
        }; // symbol => true 表示正在下单中

        this.balance = {
            okx: 0,
            binance: 0
        };

        this.fee = {
            okx: 0.0005,
            binance: 0.0005
        };

        this.leverage = {
            okx: null,
            binance: null
        }


        this.isEntry = false;
        this.entrySymbol;

        this.goalNet = {}//temp
        this.currentNet = {}//temp

        // 原 displayAll 方法中添加：



        this.init();
    }

    async init() {
        const fee = this.fee
        this.accountMonitor = new AccountMonitor({
            okx: require("../config/exchangeApi.js").okx,
            binance: require("../config/exchangeApi.js").binance,
            proxy: require("../config/start.config.js").proxy ? require("../config/start.config.js").proxy : undefined,
            lev: this.DEFAULT_ENTRY_LEVERAGE,
            onUpdate: (newState) => {
                this.accountData = newState;
                this.positions = newState.positions;
                this.balance = newState.balance;
            }
        });

        this.arbitrageMonitor = new ArbitrageMonitor({ fee });

        this.tradeExecutor = new TradeExecutor({
            apiKeys: require('../config/exchangeApi.js'),
            proxy: require("../config/start.config.js").proxy || undefined
        });

        this.minOrderChecker = new MinOrderChecker({
            mode: 'SWAP',
            proxy: require("../config/start.config.js").proxy || undefined,
        });

        this.accountMonitor.start();
        this.arbitrageMonitor.start();

        // 等待直到 this.tradingData 有数据再继续
        await new Promise(resolve => {
            const timer = setInterval(() => {
                this.tradingData = this.arbitrageMonitor.getPriceMap();
                if (this.tradingData && Object.keys(this.tradingData).length > 0) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200); // 每 200ms 检查一次
        });

        this.accountData = this.accountMonitor.getAccountMap();
        this.tradingData = this.arbitrageMonitor.getPriceMap();
        this.minOrderChecker.priceMap = this.tradingData;

        this.minOrderChecker.startAutoUpdate();

        if (this.viewModule) {
            setInterval(() => {
                this.displayAll();
            }, 1000);
        }

    }

    // 综合显示：价格表 + 持仓 + 资金
    displayAll() {
        // console.log("balance:" + JSON.stringify(this.balance));
        // console.log("accountData:" + JSON.stringify(this.accountData));
        // console.log("positions:" + JSON.stringify(this.positions));



        // 1. 显示套利机会（原逻辑）
        const priceTable = this.getTopArbitrage();
        if (priceTable.length > 0) {
            console.log("📊 套利机会（净收益率降序）");
            console.table(priceTable);
        }
        // 2. 显示持仓状态
        this.displayPositions();
        // 3. 下单中的品种
        this.displayPendingOrders();  // 👈 新增调用
        // 4. 显示资金分布
        this.displayBalances();
        // 5. 最近交易记录
        this.displayRecentTrades();
    }
    // 获取前10套利机会（原逻辑）
    getTopArbitrage() {
        return Object.entries(this.tradingData)
            .filter(([_, p]) => p.okx && p.binance && p.spreadPctNet !== null)
            .map(([symbol, p]) => ({
                symbol,
                okx: p.okxDirection === "LONG" ? p.okx.bidPx : p.okx.askPx,
                binance: p.binanceDirection === "LONG" ? p.binance.bidPx : p.binance.askPx,
                absSpread: p.absSpread?.toFixed(6),
                grossPct: p.spreadPctGross?.toFixed(6) + '%',
                netPct: p.spreadPctNet?.toFixed(6) + '%',
                direction: p.direction
            }))
            .sort((a, b) => parseFloat(b.netPct) - parseFloat(a.netPct))
            .slice(0, 10);
    }
    /* =============== 1. 持仓展示 ============== */
    displayPositions() {
        const noPositions = Object.values(this.positions).every(posMap =>
            Object.keys(posMap).length === 0
        );

        if (noPositions) {
            console.log('🔄 当前无持仓');
            return;
        }

        // console.log(this.positions)

        const rows = [];

        for (const [exchange, posMap] of Object.entries(this.positions)) {
            for (const [symbol, pos] of Object.entries(posMap)) {
                if (!pos || typeof pos.qty !== 'number' || typeof pos.entryPrice !== 'number') {
                    // console.warn(`[displayPositions] ${exchange} ${symbol} 仓位不合法，已跳过`);
                    continue;
                }

                const closePx = this.checkRealPrice(exchange, symbol,
                    pos.direction === 'LONG' ? 'bidPx' : 'askPx');

                const pnl = pos.direction === 'LONG'
                    ? (closePx - pos.entryPrice) * pos.qty
                    : (pos.entryPrice - closePx) * pos.qty;
                rows.push({
                    Symbol: symbol,
                    Exchange: exchange,
                    Direction: pos.direction,
                    EntryPrice: pos.entryPrice.toFixed(6) + ' USDT',
                    CurrentPrice: pos.currentPrice.toFixed(6) || closePx.toFixed(6) + ' USDT',
                    Quantity: pos.qty.toFixed(6) + ' ' + symbol,
                    PositionValue: pos.positionValue.toFixed(2) + ' USDT',
                    Margin: pos.margin.toFixed(2) + ' USDT',
                    goalNet: (this.goalNet[symbol] * 100).toFixed(2) + '%',
                    currentNet: (this.currentNet[symbol] * 100).toFixed(2) + '%',
                    PnL: pnl.toFixed(2) + ' USDT',
                    PnL_Pct: (pnl / pos.margin * 100).toFixed(2) + '%',
                    OpenTime: pos.ts || 0  // 加入排序用时间戳
                });
            }
        }

        // ✅ 排序逻辑：先按 symbol，后按开仓时间
        rows.sort((a, b) => {
            if (a.Symbol < b.Symbol) return -1;
            if (a.Symbol > b.Symbol) return 1;
            return a.OpenTime - b.OpenTime;
        });

        console.log("\n📌 当前持仓状态（按币种 & 时间排序）");

        console.table(rows.map(r => {
            const { OpenTime, ...cleaned } = r;  // 隐藏 OpenTime 显示
            return cleaned;
        }));
    }
    // 显示资金分布
    displayBalances() {
        const balances = Object.entries(this.balance).map(([exchange, balance]) => ({
            Exchange: exchange,
            AvaBalance: balance.toFixed(2) + ' USDT',
            UsedMargin: this.getUsedMargin(exchange)?.toFixed(2) + ' USDT' || '0.00' + ' USDT',
            PnL: this.getTotalPnL(exchange)?.toFixed(2) + ' USDT' || '0.00' + ' USDT',
            AllExBalance: this.getTotalNetAsset('ALL').toFixed(2) + ' USDT',
            NetAsset: this.getTotalNetAsset(exchange).toFixed(2) + ' USDT',
            LeverageRate: (this.leverage[exchange] * 1).toFixed(2),
            FeeSpent: this.getTotalFeesSpentByExchange(exchange).toFixed(2) + ' USDT'
        }));
        console.log("\n💰 资金分布");
        console.table(balances);
    }

    displayPendingOrders() {
        const pending = [];

        for (const exchange of ['okx', 'binance']) {
            for (const type of ['entry', 'exit']) {
                for (const symbol of Object.keys(this.ordering[exchange][type])) {
                    if (this.ordering[exchange][type][symbol]) {
                        pending.push({
                            Exchange: exchange,
                            Action: type.toUpperCase(),
                            Symbol: symbol
                        });
                    }
                }
            }
        }

        if (pending.length > 0) {
            console.log("\n🚧 当前挂单中（锁定中）:");
            console.table(pending);
        } else {
            console.log("\n✅ 当前无挂单中状态");
        }
    }


    displayRecentTrades() {
        if (this.arbitrageHistory && this.arbitrageHistory.length > 0) {
            const recentTrades = this.arbitrageHistory.slice(-5).reverse().map(t => ({
                Time: t.ts,
                Symbol: t.symbol,
                Entry: `${parseFloat(t.okx_entry).toFixed(4)}|${parseFloat(t.binance_entry).toFixed(4)}`,
                Exit: `${parseFloat(t.okx_exit).toFixed(4)}|${parseFloat(t.binance_exit).toFixed(4)}`,
                PnL: `${parseFloat(t.okx_pnl).toFixed(4)}|${parseFloat(t.binance_pnl).toFixed(4)}`,  // Already formatted as strings
                TotalPnL: parseFloat(t.totalPnL).toFixed(2),
                TotalFee: parseFloat(t.totalFee).toFixed(2),
                TotalMargin: parseFloat(t.totalMargin).toFixed(2),
                TotalNotional: parseFloat(t.totalNotional).toFixed(2),
                AvgLeverage: parseFloat(t.avgLeverage).toFixed(2),
                NetReturnPct: parseFloat(t.netReturnPct).toFixed(4) + "%" // Already includes '%'
            }));
            console.log("\n📘 最近套利完成记录");
            console.table(recentTrades);
        }
    }

    checksymbolAllList() {
        return Object.keys(this.tradingData);
    }

    checkPrice(exchange, symbol) {
        const s = this.tradingData?.[symbol];
        return (s && s[exchange] && typeof s[exchange].last === 'number')
            ? s[exchange].last
            : null;                               // 不可用时返回 null
    }


    checkRealPrice(exchange, symbol, field) {

        const symbolData = this.tradingData?.[symbol];
        const exchangeData = symbolData?.[exchange];

        if (!exchangeData) {
            console.warn(`[checkRealPrice] 未加载 ${symbol} @ ${exchange} 的行情数据`);
            return null;
        }

        if (field === 'askPx') return exchangeData.askPx;
        if (field === 'bidPx') return exchangeData.bidPx;
        return exchangeData.last;
    }

    getBidPrice(exchange, symbol) {
        return this.tradingData[symbol][exchange].bidPx;
    }

    getAskPrice(exchange, symbol) {
        return this.tradingData[symbol][exchange].askPx;
    }
    getBidSize(exchange, symbol) {
        return this.tradingData[symbol][exchange].bidSz;
    }

    getAskSize(exchange, symbol) {
        return this.tradingData[symbol][exchange].askSz;
    }


    getTotalNetAsset(exchange) {
        if (exchange === "ALL") {
            return this.getTotalNetAsset('okx') + this.getTotalNetAsset('binance');
        }
        return this.getAvailableBalance(exchange) + this.getTotalPnL(exchange);
    }
    getAvailableBalance(exchange) {
        return this.balance[exchange] - this.getUsedMargin(exchange);
    }
    getUsedMargin(exchange) {
        return Object.values(this.positions?.[exchange] || {})
            .filter(p => p && typeof p.margin === 'number')  // ✅ 过滤掉 null / undefined / 非数字
            .reduce((sum, p) => sum + p.margin, 0);
    }
    getTotalPnL(exchange) {
        if (!this.positions[exchange]) return 0;

        return Object.entries(this.positions[exchange])
            .filter(([_, p]) => p && typeof p.direction === 'string' && typeof p.qty === 'number')
            .reduce((sum, [symbol, p]) => {
                const cur = p.direction === 'LONG'
                    ? this.tradingData?.[symbol]?.[exchange]?.bidPx
                    : this.tradingData?.[symbol]?.[exchange]?.askPx;

                // 防止 cur 为 undefined
                if (typeof cur !== 'number') return sum;

                const diff = p.direction === 'LONG' ? (cur - p.entryPrice) : (p.entryPrice - cur);
                return sum + diff * p.qty;
            }, 0);
    }

    getTotalFeesSpentByExchange(exchange) {
        if (!['okx', 'binance'].includes(exchange)) {
            console.warn(`不支持的交易所: ${exchange}`);
            return 0;
        }
        // 1. 从交易历史累计已结算手续费
        const historyFees = this.exitHistory.reduce((sum, history) => {
            if (history.exchange === exchange) {
                const fee = history.fee;
                if (typeof fee === 'number' && !isNaN(fee)) {
                    return sum + fee;
                }
            }
            return sum;
        }, 0);

        // 2. 从当前持仓累计待结算手续费
        const positionFees = Object.values(this.positions[exchange] || {})
            .filter(pos => pos && typeof pos.fee === 'number')
            .reduce((sum, pos) => sum + pos.fee, 0);
        return historyFees + positionFees;
    }

    getOpenPositionCountByExchange() {
        const result = {};
        for (const ex in this.positions) {
            result[ex] = Object.keys(this.positions[ex]).length;
        }
        return result;
    }

    getMinUsdt(exchange, symbol) {
        return this.minOrderChecker.getMinUsdt(exchange, symbol)
    }

    updateLeverage(exchange) {
        let totalNotional = 0;
        let totalEquity = this.getTotalNetAsset(exchange);

        const symMap = this.positions?.[exchange] || {};
        for (const [symbol, pos] of Object.entries(symMap)) {
            if (
                !pos ||
                typeof pos.qty !== 'number' ||
                typeof pos.currentPrice !== 'number' ||
                typeof pos.margin !== 'number'
            ) {
                continue;
            }

            const notional = Math.abs(pos.qty * pos.currentPrice);
            const margin = pos.margin;

            // 设置 symbol 级别的杠杆
            pos.leverage = margin > 0 ? (notional / margin) : 0;

            totalNotional += notional;

        }

        // 设置 exchange 级别的杠杆
        if (!this.leverage) this.leverage = {};
        this.leverage[exchange] = totalEquity > 0.01 ? (totalNotional / totalEquity) : 0; // 添加最小阈值

    }

    calcQtyByUsdt(exchange, symbol, qtyUSDT) {
        //okx 合约 以张数为单位
        //binance 合约 以币数为单位

        if (exchange === 'okx') {
            // console.log(`${qtyUSDT / this.minOrderChecker.getMinUsdt(exchange, symbol)} ${this.minOrderChecker.getMinUsdt(exchange, symbol)} ${this.checkPrice(exchange, symbol)}`)

            return Math.max(1, Math.floor(qtyUSDT / this.minOrderChecker.getMinUsdt(exchange, symbol)))   // ↓ 向下取整

        } else if (exchange === 'binance') {
            return qtyUSDT / this.checkPrice(exchange, symbol);
        }


    }

    async entry(exchange, symbol, direction, marginUSDT, leverage) {

        const symbolData = this.tradingData?.[symbol];
        for (const ex of ['okx', 'binance']) {
            const exchangeData = symbolData?.[ex];

            if (!exchangeData) {
                console.warn(`[entry] 未加载 ${symbol} @ ${ex} 的行情数据`);
                return { success: false, error: 'unload' };;
            }
        }


        if (this.ordering[exchange].entry[symbol]) {
            // console.log(`[SKIP] ${symbol} 正在下单中，跳过`);
            return { success: false, error: 'locked' };
        }
        // ✅ 设置锁
        this.ordering[exchange].entry[symbol] = true;

        const orderQty = this.calcQtyByUsdt(exchange, symbol, marginUSDT * leverage)
        console.log(`[ENTRY] ${exchange} ${symbol} ${direction} ${marginUSDT * leverage} 尝试下单 `)
        const order = await this.tradeExecutor.placeOrder(exchange, symbol, false, direction.toLowerCase(), orderQty, 'market', this.DEFAULT_ENTRY_LEVERAGE);



        if (!order || !order.id) {
            console.warn(`[ENTRY-FAIL] ${exchange} ${symbol} 下单失败或无响应`);
            this.ordering[exchange].entry[symbol] = false; // ✅ 解锁！
            return { success: false, error: 'order-failed' };
        }


        /* ---- 更新账户信息 ---- */
        this.accountData = this.accountMonitor.getAccountMap();

        // console.log(this.accountData);

        const accountDataPos = this.accountData.positions?.[exchange]?.[symbol];
        // ✅ 等待账户同步更新

        const DEADLINE = Date.now() + 10_000;   // 最多等 10s
        let qty = 0;

        while (Date.now() < DEADLINE) {
            const p = this.accountMonitor.getAccountMap()
                .positions?.[exchange]?.[symbol];
            qty = p?.qty || 0;
            if (qty > 0) break;                 // ✓ 拿到了

            await new Promise(r => setTimeout(r, 200)); // 间隔短点
        }

        if (qty === 0) {
            console.warn(`[ENTRY] ${exchange} ${symbol} 等待 8s 仍无 qty，同步失败`);
        }
        if (qty <= 0) {
            console.warn(`[ENTRY-WARN] ${exchange} ${symbol} 多次尝试后仍无法获取仓位 qty`);
            this.ordering[exchange].entry[symbol] = false;
            return { success: false, error: 'qty-invalid' };
        }


        let success = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 200));

            // ✅ 每轮重新拉账户状态
            this.accountData = this.accountMonitor.getAccountMap();

            const check = this.accountData?.positions?.[exchange]?.[symbol];
            const remQty = check?.qty || 0;
            if (remQty >= qty * 0.95) {
                success = true;
                break;
            }
        }
        this.accountData = this.accountMonitor.getAccountMap();

        const pos = this.accountData?.positions?.[exchange]?.[symbol];


        if (!pos || pos.qty <= 0) {
            console.warn(`[ENTRY-WARN] ${exchange} ${symbol} 下单后未检测到持仓`);
            this.ordering[exchange].entry[symbol] = false; // ✅ 解锁！
            return { success: false, error: 'position-not-found' };
        }

        // ✅ 解锁
        this.ordering[exchange].entry[symbol] = false;

        // recorder 部分

        if (!accountDataPos) return { success: false, error: 'position-data-missing' };




        // 记录建仓开始时间，供瘸腿检测做缓冲
        if (!this.pairPending[symbol]) {
            this.pairPending[symbol] = Date.now();
        }


        return { success: true, order };
    }

    async safeExit(exchange, symbol, amountUSDT = null, maxRetry = 10) {
        if (this.ordering[exchange].exit[symbol]) {
            // console.log(`[SKIP] ${symbol} 正在下单中，跳过`);
            return { success: false, error: 'locked' };
        }
        for (let i = 0; i < maxRetry;) {
            const res = await this.exit(exchange, symbol, amountUSDT);

            if (res?.success) {
                console.log(`[SAFE-EXIT] ${exchange} ${symbol} 平仓成功 ✅`);
                delete this.pairPending[symbol];   // 成功平仓就清掉 pending
                return res;
            }


            if (!this.positions?.[exchange]?.[symbol]) {
                console.log(`[SAFE-EXIT] ${exchange} ${symbol} 已平仓 ✅`);
                delete this.pairPending[symbol];   // 成功平仓就清掉 pending
                return { success: true, note: 'already closed' };
            }

            if (res?.error === 'locked') {
                // console.log(`[SAFE-EXIT] ${exchange} ${symbol} 当前处于锁定中，等待释放...`);
                await new Promise(r => setTimeout(r, 500));
                // ⚠️ 不增加 i，继续下一轮等待
                continue;
            }

            if (res?.error === 'undefinedEntry') {
                console.log(`[SAFE-EXIT] ${exchange} ${symbol} 已平仓 ✅`);
                delete this.pairPending[symbol];   // 成功平仓就清掉 pending
                return;
            }

            console.warn(`[SAFE-EXIT] ${exchange} ${symbol} 第 ${i + 1} 次平仓失败，错误信息: ${res?.error || '未知错误'}`);
            i++;  // 只有真正失败才增加重试次数
            await new Promise(r => setTimeout(r, 500));
        }

        console.error(`[SAFE-EXIT] ${exchange} ${symbol} 平仓最终失败 ❌`);
        return { success: false, error: 'max-retries-exceeded' };  // ✅ 就在这里
    }




    async exit(exchange, symbol, amountUSDT = null) {
        const pos = this.positions?.[exchange]?.[symbol];
        if (this.ordering[exchange].exit[symbol]) {
            // console.log(`[SKIP] ${symbol} 正在下单中，跳过`);
            return { success: false, error: 'locked' };
        }
        // ✅ 设置锁
        this.ordering[exchange].exit[symbol] = true;


        let closeNotional;

        const qty = parseFloat(pos?.qty);
        const price = parseFloat(pos?.currentPrice);

        if (!amountUSDT) {
            if (!qty || !price) {
                console.warn(`[EXIT] ${exchange} ${symbol} 无效仓位数据 qty=${qty}, price=${price}，跳过平仓`);
                this.ordering[exchange].exit[symbol] = false;
                return { success: false, error: 'invalid-position' };
            }

            closeNotional = Math.abs(qty * price * 2); // 默认全仓 *2（保障全平）
        } else {
            closeNotional = amountUSDT;
        }

        console.log(`[EXIT] ${exchange} ${symbol} ${closeNotional} 尝试平仓`)
        if (!pos) {
            const msg = `[EXIT-FAIL] 找不到仓位 ${exchange} ${symbol} ${pos}`;
            this.ordering[exchange].exit[symbol] = false;
            console.warn(msg);
            return { success: false, error: 'undefinedEntry' };
        }



        const orderQty = this.calcQtyByUsdt(exchange, symbol, closeNotional)

        const order = await this.tradeExecutor.placeOrder(exchange, symbol, true, pos.direction.toLowerCase(), orderQty, 'market', this.DEFAULT_ENTRY_LEVERAGE);


        if (!order || !order.id) {
            const msg = `[EXIT-FAIL] ${exchange} ${symbol} 平仓失败`;
            this.ordering[exchange].exit[symbol] = false;
            console.warn(msg);
            return { success: false, error: msg };
        }

        // 等待账户同步，最长 2 秒
        let synced = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 200));
            const p = this.accountMonitor.getAccountMap()
                .positions?.[exchange]?.[symbol];
            if (!p || p.qty === 0) {
                synced = true;
                break;
            }
        }


        // ✅ 解锁
        this.ordering[exchange].exit[symbol] = false;



        /* ---------- 更新剩余仓位 ---------- */
        /* ---- 更新账户信息 ---- */
        this.accountData = this.accountMonitor.getAccountMap();

        return { success: true, order };

    }

    async exitAll(exchange) {
        const exPos = Object.keys(this.positions?.[exchange] || {});
        const tasks = exPos.map(sym => this.exit(exchange, sym));
        return Promise.allSettled(tasks);  // 返回所有执行结果
    }

    filterTradingDataByMinUsdtMap() {


        const allMinSymbols = new Set([
            ...Object.keys(this.minOrderChecker.minUsdtMap.okx),
            ...Object.keys(this.minOrderChecker.minUsdtMap.binance)
        ]);
        const filtered = {};
        for (const [symbol, data] of Object.entries(this.tradingData)) {
            if (allMinSymbols.has(symbol)) {
                filtered[symbol] = data;
            }
        }
        this.tradingData = filtered;

    }

    syncBySnapshot(entryPrice = null) {


        const accountDataLog = this.accountData.snapshotLog

        for (const log of accountDataLog) {
            if (log.processed) continue;   // 简易去重标记

            if (!this.exitHistory) this.exitHistory = [];// 若无交易记录则创建新记录
            if (!this.entryHistory) this.entryHistory = [];// 若无交易记录则创建新记录


            const margin = log.qty * log.price - log.pnl
            const leverage = (log.qty * log.entryPrice) / margin;
            const notionalValue = log.qty * log.entryPrice;

            const entryPrice = log.posSide === 'LONG' ? exitPrice - (pnl / qty) : exitPrice + (pnl / qty);

            this.tradingHistory.push({
                ts: log.ts,
                exchange,
                symbol,
                direction: log.posSide,
                entryPrice,
                exitPrice: log.price,
                closeQty: log.qty,
                notionalValue: notionalValue,  // 实际持仓金额
                leverage: leverage,
                pnl: log.pnl,
                fee: log.fee,
                margin: margin,
                netReturnPct: ((pnl / margin) * 100)
            });

            if (log.side === 'ENTRY') {

                this.entryHistory.push({
                    ts: log.ts,
                    exchange,
                    symbol,
                    direction: log.posSide,
                    entryPrice,
                    exitPrice: log.price,
                    closeQty: log.qty,
                    notionalValue: notionalValue,  // 实际持仓金额
                    leverage: leverage,
                    pnl: log.pnl,
                    fee: log.fee,
                    margin: margin,
                    netReturnPct: ((pnl / margin) * 100)
                });


            } else if (log.side === 'EXIT')

                this.exitHistory.push({
                    ts: log.ts,
                    exchange,
                    symbol,
                    direction: log.posSide,
                    entryPrice,
                    exitPrice: log.price,
                    closeQty: log.qty,
                    notionalValue: notionalValue,  // 实际持仓金额
                    leverage: leverage,
                    pnl: log.pnl,
                    fee: log.fee,
                    margin: margin,
                    netReturnPct: ((pnl / margin) * 100)
                });

        }

    }



    recordCompletedArbitrageTrade(symbol,
        exchangeA = 'okx',
        exchangeB = 'binance') {

        const posOkx = this.positions?.okx?.[symbol];
        const posBinance = this.positions?.binance?.[symbol];

        if (!posOkx || !posBinance) {
            return console.warn(`[arbitrage] 缺少 ${symbol} 的双边仓位`);
        }

        /* ----------  平仓价 & PnL ---------- */
        const closePxOkx = this.checkRealPrice('okx', symbol,
            posOkx.direction === 'LONG' ? 'bidPx' : 'askPx');
        const closePxBinance = this.checkRealPrice('binance', symbol,
            posBinance.direction === 'LONG' ? 'bidPx' : 'askPx');

        const qtyOkx = posOkx.qty;
        const qtyBinance = posBinance.qty;

        const pnlOkx = posOkx.direction === 'LONG'
            ? (closePxOkx - posOkx.entryPrice) * qtyOkx
            : (posOkx.entryPrice - closePxOkx) * qtyOkx;

        const pnlBinance = posBinance.direction === 'LONG'
            ? (closePxBinance - posBinance.entryPrice) * qtyBinance
            : (posBinance.entryPrice - closePxBinance) * qtyBinance;

        /* ---------- 手续费 ---------- */
        const feeCloseOkx = closePxOkx * qtyOkx * this.fee.okx;
        const feeCloseBinance = closePxBinance * qtyBinance * this.fee.binance;

        const feeOkx = posOkx.fee + feeCloseOkx;
        const feeBinance = posBinance.fee + feeCloseBinance;

        /* ---------- 杠杆 & 名义金额 ---------- */
        const notionalOkx = qtyOkx * posOkx.entryPrice;
        const notionalBinance = qtyBinance * posBinance.entryPrice;

        const leverageOkx = notionalOkx / posOkx.margin;
        const leverageBinance = notionalBinance / posBinance.margin;

        /* ---------- 写入单边流水 ---------- */
        // this.recordCompletedTrade('okx', symbol, qtyOkx, pnlOkx, feeOkx, posOkx.margin);
        // this.recordCompletedTrade('binance', symbol, qtyBinance, pnlBinance, feeBinance, posBinance.margin);

        /* ---------- 汇总套利流水 ---------- */
        if (!this.arbitrageHistory) this.arbitrageHistory = [];

        const totalPnL = pnlOkx + pnlBinance;
        const totalFee = feeOkx + feeBinance;
        const totalMargin = posOkx.margin + posBinance.margin;
        const totalNotional = notionalOkx + notionalBinance;
        const avgLeverage = (leverageOkx + leverageBinance) / 2;
        const netReturnPct = (totalPnL / totalMargin) * 100;

        this.arbitrageHistory.push({
            ts: new Date().toLocaleString(),
            symbol,

            /* —— OKX —— */
            okx_direction: posOkx.direction,
            okx_entry: posOkx.entryPrice,
            okx_exit: closePxOkx,
            okx_qty: qtyOkx,
            okx_notional: notionalOkx,
            okx_leverage: leverageOkx,
            okx_pnl: pnlOkx,
            okx_fee: feeOkx,
            okx_margin: posOkx.margin,

            /* —— Binance —— */
            binance_direction: posBinance.direction,
            binance_entry: posBinance.entryPrice,
            binance_exit: closePxBinance,
            binance_qty: qtyBinance,
            binance_notional: notionalBinance,
            binance_leverage: leverageBinance,
            binance_pnl: pnlBinance,
            binance_fee: feeBinance,
            binance_margin: posBinance.margin,

            /* —— 汇总 —— */
            totalNotional: totalNotional,
            avgLeverage: avgLeverage,
            totalPnL: totalPnL,
            totalFee: totalFee,
            totalMargin: totalMargin,
            netReturnPct: netReturnPct
        });
    }

    riskDetectors(mode = 'cross') {
        const RISK_MARGIN_RATIO = 0.95; // 爆仓保证金比例临界（90% = 高风险）

        if (!this.tradingData || Object.keys(this.tradingData).length === 0) {
            // console.warn('[SKIP] tradingData 为空，跳过该函数');
            return;
        }

        for (const [exchange, posMap] of Object.entries(this.positions)) {
            for (const [symbol, pos] of Object.entries(posMap)) {
                if (!pos || !pos.direction) continue;

                const curPrice = this.checkPrice(exchange, symbol);
                const entry = pos.entryPrice;
                const qty = pos.qty;
                const margin = pos.margin;
                const feeRate = this.fee?.[exchange] ?? 0;

                const notional = qty * curPrice;
                const pnl = pos.direction === 'LONG'
                    ? (curPrice - entry) * qty
                    : (entry - curPrice) * qty;

                if (mode === 'cross') {
                    if (margin <= 0) {
                        console.warn(`[RISK-SKIP][${exchange}][${symbol}] 保证金为 0，跳过计算`);
                        continue;
                    }

                    const netAsset = this.getTotalNetAsset(exchange); // 全部资产
                    const usedMargin = this.getUsedMargin(exchange);
                    const available = netAsset - usedMargin;
                    const marginRatio = (margin + pnl) / margin;

                    if (marginRatio <= (1 - RISK_MARGIN_RATIO)) {
                        console.warn(`[RISK][${exchange}][${symbol}] ${pos.direction} 已接近爆仓，净值比=${pos.qty} ${margin}+${pnl} / ${margin}`);
                        this.exit(exchange, symbol);//强制平仓
                    }

                } else if (mode === 'isolated') {
                    // 逐仓：仅依赖该持仓保证金
                    const lossRatio = Math.abs(pnl) / margin;
                    if (lossRatio >= RISK_MARGIN_RATIO) {
                        console.warn(`[RISK][逐仓][${exchange}][${symbol}] ${pos.direction} 接近爆仓！亏损比例=${(lossRatio * 100).toFixed(2)}%`);
                        this.exit(exchange, symbol);//强制平仓
                    }
                }
            }
        }
    }



    async update() {
        if (!this.tradingData || Object.keys(this.tradingData).length === 0) {
            // console.warn('[SKIP] tradingData 为空，跳过该函数');
            return;
        }

        if (this.positions.okx && this.positions.binance) {
            for (const [exchange, symbolMap] of Object.entries(this.positions)) {
                for (const [symbol, position] of Object.entries(symbolMap)) {
                    // 防御：行情还没推到就先跳过
                    if (!position || typeof position.qty !== 'number') {
                        console.warn(`Invalid position: ${exchange} ${symbol}`);
                        continue;
                    }
                    // 获取最新价格（确保返回数字）
                    const field = position.direction === 'LONG' ? 'bidPx' : 'askPx'


                    const currentPrice = this.checkRealPrice(exchange, symbol, field);
                    if (typeof currentPrice !== 'number' || isNaN(currentPrice)) {
                        console.warn(`Invalid price for ${exchange} ${symbol}`);
                        continue;
                    }
                    // 更新仓位数据
                    position.currentPrice = currentPrice;
                    position.positionValue = currentPrice * position.qty;
                }

            }

            /* ---- 更新杠杆显示 ---- */
            this.updateLeverage('okx');
            this.updateLeverage('binance');
            /* ---- 更新仓位风险情况 ---- */
            this.riskDetectors()

        }

    }

    run() {
    let running = false;

    const loop = async () => {
        if (running) return;
        running = true;

        try {
            this.tradingData = this.arbitrageMonitor.getPriceMap();
            this.minOrderChecker.priceMap = this.tradingData;

            this.filterTradingDataByMinUsdtMap();

            // ❗不再手动调用 getAccountMap()，由 onUpdate 自动维护 this.positions/balance/accountData
            await this.update();     // 包含 risk 检查 + price 更新
            await this.strategy();   // 核心策略
        } catch (err) {
            console.error('[Strategy Error]', err);
            await this.exitAll('okx');
            await this.exitAll('binance');
            process.exit(1);
        } finally {
            running = false;
        }
    };

    setInterval(loop, this.refreshInterval);
}

    async strategy() {

        if (!this.tradingData || Object.keys(this.tradingData).length === 0) {
            // console.warn('[SKIP] tradingData 为空，跳过该函数');
            return;
        }

        const REDUCE_ONLY_MODE = true; // ✅ 只减仓模式开关
        const MAX_HOLD_SECONDS = 600;          // 持仓最长周期 (600秒 = 10分钟)
        const MAX_MARGIN_PER_POSITION = 200;  // 每个币种最多保证金投入（单位 USDT）
        const SPREAD_TARGET_MAX = 1.2;         // 最初目标是 1.2 × 初始spreadPctNet
        const SPREAD_TARGET_MIN = 0.8;         // 最终目标是 0.3 × 初始spreadPctNet
        const GOAL_NET_PCT = 0.5 * 0.01;              // 目标净收益率 0.002 （未百分比换算）

        const MAX_OPEN = 5;          // 最多并行币对
        const ENTRY_TH = 0.3;       // 开仓价差目标 0.30 (以百分比换算)
        const BASE_MARGIN = 10;        // 每次默认投入保证金（USDT）
        const LEVERAGE = 5;          // 初始杠杆（1 倍）

        const MIN_MARGIN = 0.4;    //最小的单次成交保证金额度金额；实际成交为MIN_MARGIN * LEVERAGE

        const minMargin = MIN_MARGIN * LEVERAGE

        if (!Object.keys(this.tradingData).length) return;


        for (const sym of Object.keys(this.tradingData)) {

            /* === 0. 正在下单 or 缓冲期内直接跳过 === */
            if (this.ordering.okx.entry[sym] || this.ordering.binance.entry[sym]) continue;

            const pendTs = this.pairPending[sym];
            if (pendTs && Date.now() - pendTs < TradingControl.LEG_GRACE_MS) continue;


            const okxPos = this.positions?.okx?.[sym];
            const binPos = this.positions?.binance?.[sym];

            const locked = this.ordering?.okx?.entry?.[sym] || this.ordering?.okx?.exit?.[sym] ||
                this.ordering?.binance?.entry?.[sym] || this.ordering?.binance?.exit?.[sym];
            if (locked) continue; // 有挂单锁就跳过

            const hasOkx = !!okxPos;
            const hasBin = !!binPos;

            let legSide = null;

            // ✅ 只有一侧有仓位
            if (hasOkx && !hasBin) {
                legSide = 'okx';
            } else if (!hasOkx && hasBin) {
                legSide = 'binance';
            }
            // ✅ 两侧都有仓，但保证金差异超过 50%
            else if (hasOkx && hasBin) {
                const m1 = okxPos.margin;
                const m2 = binPos.margin;
                const diffRatio = Math.abs(m1 - m2) / Math.max(m1, m2);

                if (diffRatio >= 0.5) {
                    // 平掉保证金较小的一侧（通常是异常侧）
                    legSide = m1 < m2 ? 'okx' : 'binance';
                    console.warn(`[LEG-PROTECT] ${sym} 虽然双腿都有仓，但保证金差异 ${diffRatio * 100}%，将平掉 ${legSide}`);
                }
            }

            if (legSide) {
                delete this.pairPending[sym];      // 立刻移除，防止残留
                const pos = this.positions?.[legSide]?.[sym];
                const amountUSDT = pos.qty * pos.entryPrice;

                console.warn(`[LEG-PROTECT] 检测到 ${sym} 存在瘸腿或失衡仓位，开始平掉 ${legSide}`);
                await this.safeExit(legSide, sym);
                console.warn(`[LEG-PROTECT] 已补救平仓 ${legSide} ${sym}`);
            }

            if (pendTs && okxPos && binPos) delete this.pairPending[sym];
        }


        // ✅ 错误方向保护逻辑（做多价高于做空）
        // 提前止损，避免注定亏损的入场
        const allSymbols = new Set([
            ...Object.keys(this.positions.okx || {}),
            ...Object.keys(this.positions.binance || {})
        ]);

        for (const sym of allSymbols) {
            const posOkx = this.positions.okx[sym];
            const posBin = this.positions.binance?.[sym];
            if (!posOkx || !posBin) continue;

            const isWrongDirection =
                posOkx.direction === 'LONG' &&
                posBin.direction === 'SHORT' &&
                posOkx.entryPrice > posBin.entryPrice;

            const isWrongDirection2 =
                posOkx.direction === 'SHORT' &&
                posBin.direction === 'LONG' &&
                posOkx.entryPrice < posBin.entryPrice;

            if (isWrongDirection || isWrongDirection2) {
                // console.warn(`[PROTECT] 检测到 ${sym} 入场方向错误，OKX=${posOkx.entryPrice} / Binance=${posBin.entryPrice}，立即双边平仓`);
                await Promise.all([
                    this.safeExit('okx', sym),
                    this.safeExit('binance', sym)
                ]);
            }
        }


        /* ==== 1. 生成 & 排序候选 ==== */
        const cands = Object.entries(this.tradingData).map(([sym, p]) => ({
            symbol: sym,
            netPct: p.spreadPctNet,
            okxDirection: p.okxDirection,      // 已在 updateSpread 中写好
            okxBid: p.okx.bidPx,
            okxAsk: p.okx.askPx,
            binBid: p.binance.bidPx,
            binAsk: p.binance.askPx
        })).sort((a, b) => b.netPct - a.netPct);

        /* ==== 2. 开仓逻辑 ==== */

        for (const c of cands) {


            /* 2-A. 并行数量上限 */
            const posCount = this.getOpenPositionCountByExchange();
            if (posCount.okx >= MAX_OPEN && posCount.binance >= MAX_OPEN) {
                // console.log(`[SKIP] MAX_OPEN (${MAX_OPEN}) 已达上限`);
                break;                                  // ← 直接 break
            }

            /* 2-B. 价差阈值不足 */
            if (c.netPct < ENTRY_TH) {
                // console.log(`[SKIP] ${c.symbol} spread ${c.netPct.toFixed(3)} < ENTRY_TH ${ENTRY_TH}`);
                break;                                  // ← 后面都更低，直接截断
            }

            const sym = c.symbol;
            /* 2-C. 只减仓模式下已持双腿 ⇒ 跳过 */
            const okxPos = this.positions.okx?.[sym];
            const binPos = this.positions.binance?.[sym];

            if (okxPos?.qty > 0 && binPos?.qty > 0 && REDUCE_ONLY_MODE) {
                // console.log(`[SKIP] ${sym} 已持仓且 REDUCE_ONLY_MODE`);
                continue;
            }

            /* ---- 确定方向 & 可成交量 ---- */
            const okxLong = c.okxDirection; // true=>OKX做多
            const dirOkx = okxLong === 'LONG' ? 'LONG' : 'SHORT';
            const dirBin = okxLong === 'LONG' ? 'SHORT' : 'LONG';


            const marginOkx = this.positions.okx?.[sym]?.margin || 0;
            const marginBin = this.positions.binance?.[sym]?.margin || 0;
            const totalMargin = marginOkx + marginBin;

            if (totalMargin >= MAX_MARGIN_PER_POSITION) {
                console.log(`[SKIP] ${sym} margin ${totalMargin.toFixed(2)} ≥ MAX_MARGIN_PER_POSITION`);
                continue;
            }
            // 买一/卖一可撮合 USDT 量
            const depthUsdt = okxLong
                ? Math.min(c.okxAsk * this.tradingData[c.symbol].okx.bidSz, c.binBid * this.tradingData[c.symbol].binance.bidSz)
                : Math.min(c.okxBid * this.tradingData[c.symbol].okx.bidSz, c.binAsk * this.tradingData[c.symbol].binance.askSz);

            // 实际下单金额 = 深度 / 杠杆
            const useMargin = Math.min(BASE_MARGIN, depthUsdt * 1.5 / LEVERAGE, this.getAvailableBalance('okx'), this.getAvailableBalance('binance'));
            if (useMargin < minMargin) {
                // console.log(`[SKIP] ${sym} useMargin ${useMargin.toFixed(2)} < minMargin ${minMargin}`);
                continue;
            }
            if (useMargin * LEVERAGE < Math.max(this.getMinUsdt('okx', sym), this.getMinUsdt('binance', sym))) {
                // console.log(`[SKIP] ${sym} 名义金额不足 MIN_NOTIONAL ${Math.max(this.getMinUsdt('okx', sym),
                // this.getMinUsdt('binance', sym))}`);
                continue;
            }

            /* ---- 下单 ---- */
            // 并行同时下两单
            const [resOkx, resBin] = await Promise.all([
                this.entry('okx', sym, dirOkx, useMargin, LEVERAGE),
                this.entry('binance', sym, dirBin, useMargin, LEVERAGE)
            ]);

            // -------- 保护逻辑：此时两边一定都有结构 -------- //
            if (!resOkx.success && resBin.success) {
                console.warn('[ENTRY-PROTECT] OKX 下单失败，立即平掉 Binance  error: ' + JSON.stringify(resOkx));
                await this.safeExit('binance', sym);
                return;   // 终止本轮
            }

            if (!resBin.success && resOkx.success) {
                console.warn('[ENTRY-PROTECT] Binance 下单失败，立即平掉 OKX  error: ' + JSON.stringify(resBin));
                await this.safeExit('okx', sym);
                return;
            }

            const bothLocked = resOkx.error === 'locked' && resBin.error === 'locked';
            const bothFailed = !resOkx.success && !resBin.success && !bothLocked;

            if (bothLocked) {
                // console.warn(`[ENTRY-PROTECT] OKX & Binance 同时锁仓中，稍后重试`);
                return; // 或者你可以 return { success: false, error: 'both-locked' }
            }

            if (bothFailed) {
                console.warn('[ENTRY-PROTECT] 两侧下单均失败，放弃建仓', resOkx, resBin);
                return;
            }

            // 双边成功 → 检查名义价值误差
            const valOkx = resOkx.qty * (resOkx.order?.price || this.checkRealPrice('okx', sym, dirOkx === 'LONG' ? 'askPx' : 'bidPx'));
            const valBin = resBin.qty * (resBin.order?.price || this.checkRealPrice('binance', sym, dirBin === 'LONG' ? 'askPx' : 'bidPx'));
            const diffPct = Math.abs(valOkx - valBin) / Math.max(valOkx, valBin);

            if (diffPct > 0.1) {
                console.warn(`[ENTRY-MISMATCH] ${sym} 名义价值误差 ${(diffPct * 100).toFixed(2)}%，立即平仓`);
                await this.exit('okx', sym, useMargin);
                await this.exit('binance', sym, useMargin);
                continue;
            }


        }

        /* ==== 3. 平仓逻辑（逐 symbol 检查） ==== */


        const exitPairs = []; // 收集所有可平的币种

        for (const symbol of Object.keys(this.tradingData)) {
            const posOkx = this.positions?.okx?.[symbol];
            const posBin = this.positions?.binance?.[symbol];
            if (!posOkx || !posBin) continue;

            const now = Date.now();
            const heldSeconds = (now - Math.min(posOkx.ts, posBin.ts)) / 1000;
            const pnlOkx = (posOkx.direction === 'LONG'
                ? (posOkx.currentPrice - posOkx.entryPrice)
                : (posOkx.entryPrice - posOkx.currentPrice)) * posOkx.qty;

            const pnlBin = (posBin.direction === 'LONG'
                ? (posBin.currentPrice - posBin.entryPrice)
                : (posBin.entryPrice - posBin.currentPrice)) * posBin.qty;

            const curSpreadPctNet = (pnlOkx + pnlBin) /
                (posOkx.margin + posBin.margin);

            /* ---- 动态目标 ---- */
            const ratioHeld = Math.min(heldSeconds / MAX_HOLD_SECONDS, 1);  // 0→1
            const taper = SPREAD_TARGET_MAX - (SPREAD_TARGET_MAX - SPREAD_TARGET_MIN) * ratioHeld;
            const goalNetPct = GOAL_NET_PCT * taper;

            this.goalNet[symbol] = goalNetPct;          // 直接记录目标 ROI 百分比
            this.currentNet[symbol] = curSpreadPctNet;  // 当前 ROI
            // console.log(`${pnlOkx + pnlBin}  |  ${posBin.margin + posOkx.margin}  |  ${curSpreadPctNet} | ${goalNetPct} | ${(goalNetPct+1)*(posBin.margin + posOkx.margin)}`)



            if (curSpreadPctNet < goalNetPct) continue; //当前收益 < 目标收益 跳出平仓循环 


            const okxDepth = posOkx.direction === 'LONG' ? this.getBidSize('okx', symbol) : this.getAskSize('okx', symbol);
            const binDepth = posBin.direction === 'LONG' ? this.getBidSize('binance', symbol) : this.getAskSize('binance', symbol);
            const minDepth = Math.min(okxDepth, binDepth);
            const availableUSDT = minDepth * 0.8 / LEVERAGE;// 实际下单金额 = 深度 / 杠杆

            const valueOkx = posOkx.qty * posOkx.entryPrice;
            const valueBin = posBin.qty * posBin.entryPrice;
            const closeAmountUSDT = Math.min(availableUSDT, valueOkx, valueBin);

            if (closeAmountUSDT < minMargin) continue;// 平仓金额 < 最小平仓限定金额 跳出平仓循环 

            exitPairs.push({ symbol, closeAmountUSDT });
            // console.log(symbol+ "|" + curSpreadPctNet+ "|" +goalNetPct);
        }

        // ✅ 统一同时平仓（双腿）
        if (Object.entries(exitPairs).length > 0) {
            for (const { symbol, closeAmountUSDT } of exitPairs) {
                // console.log(symbol+ "平仓");
                this.recordCompletedArbitrageTrade(symbol);
                await Promise.all([
                    this.safeExit('okx', symbol, closeAmountUSDT),
                    this.safeExit('binance', symbol, closeAmountUSDT)
                ]);
            }
        }

    }

}



function main() {
    const tc = new TradingControl({ view: false });
    tc.run();
}

main();//持仓状态获取有问题
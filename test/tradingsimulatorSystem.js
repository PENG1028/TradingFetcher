const ArbitrageMonitor = require('./ws-fetcher-test.js');

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
    constructor(module = 'simulat', view = true, fee = { okx: 0.001, binance: 0.001 }) {
        this.refreshInterval = 10;// ms
        this.viewModule = view;

        this.AM;
        this.tradingData;
        this.positions = {};
        this.positionMeta = {};
        this.arbitrageHistory = [];
        this.tradeHistory = [];
        this.balance = {
            okx: 1000,
            binance: 1000
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

        this.goalNet = {}


        this.init();
    }

    init() {
        const fee = this.fee
        this.AM = new ArbitrageMonitor({ fee });
        this.AM.start();
        this.tradingData = this.AM.getPriceMap();
        if (this.viewModule) {
            setInterval(() => {
                this.displayAll();
            }, 1000);
        }

    }

    // 综合显示：价格表 + 持仓 + 资金
    displayAll() {
        console.clear();

        // 1. 显示套利机会（原逻辑）
        const priceTable = this.getTopArbitrage();
        if (priceTable.length > 0) {
            console.log("📊 套利机会（净收益率降序）");
            console.table(priceTable);
        }
        // 2. 显示持仓状态
        this.displayPositions();
        // 3. 显示资金分布
        this.displayBalances();
        // 4. 最近交易记录
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
        if (Object.keys(this.positions).length === 0) {
            console.log('🔄 当前无持仓');
            return;
        }

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
                    Goal: `${this.goalNet[symbol].toFixed(2)} USDT`,
                    Margin: pos.margin.toFixed(2) + ' USDT',
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
        if (field === 'askPx') {
            return this.tradingData[symbol][exchange].askPx;
        } else if (field === 'bidPx') {
            return this.tradingData[symbol][exchange].bidPx;
        }
        return this.tradingData[symbol][exchange].last;
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
        return this.getAvailableBalance(exchange) + this.getUsedMargin(exchange) + this.getTotalPnL(exchange);
    }
    getAvailableBalance(exchange) {
        return this.balance[exchange];
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
        const historyFees = this.tradeHistory.reduce((sum, history) => {
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

    getOpenPositionCount() {
        let n = 0;
        for (const ex in this.positions) {
            n += Object.keys(this.positions[ex]).length;
        }
        return n;
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

    entry(exchange, symbol, direction, marginUSDT, leverage) {
        const field = direction === 'LONG' ? 'askPx' : 'bidPx';
        const fee = marginUSDT * leverage * this.fee[exchange];   // 手续费
        const qty = (marginUSDT * leverage - fee) / this.checkRealPrice(exchange, symbol, field);
        const pos = this.positions[exchange]?.[symbol];

        if (pos && pos.direction === direction) {
            const newQty = pos.qty + qty;
            pos.entryPrice = (pos.entryPrice * pos.qty + this.checkRealPrice(exchange, symbol, field) * qty) / newQty;
            pos.qty = newQty;
            pos.margin += marginUSDT;
            pos.fee += fee;
        } else {                         // 🆕 新仓
            if (!this.positions[exchange]) this.positions[exchange] = {};
            this.positions[exchange][symbol] = {
                symbol,
                direction,
                entryPrice: this.checkRealPrice(exchange, symbol, field),
                currentPrice: this.checkRealPrice(exchange, symbol, field),
                qty,
                margin: marginUSDT,
                positionValue: this.checkRealPrice(exchange, symbol, field) * qty,
                fee,
                ts: Date.now()
            };
        }
        this.balance[exchange] -= marginUSDT;          // 扣除新保证金
    }



    exit(exchange, symbol, amountUSDT = null) {

        const pos = this.positions?.[exchange]?.[symbol];
        if (!pos) return console.warn(`[exit] 找不到仓位 ${exchange} ${symbol}`);

        // ✅ 默认全部平仓
        const closeMargin = amountUSDT > 0 ? Math.min(amountUSDT, pos.margin) : pos.margin;
        const closeRatio = closeMargin / pos.margin;
        const closeQty = pos.qty * closeRatio;

        const closePx = this.checkRealPrice(exchange, symbol,
            pos.direction === 'LONG' ? 'bidPx' : 'askPx');       // 平仓价

        /* ---------- 计算 PnL & 返还保证金 ---------- */
        const pnl = pos.direction === 'LONG'
            ? (closePx - pos.entryPrice) * closeQty
            : (pos.entryPrice - closePx) * closeQty;

        const feeUse = this.fee[exchange] * closePx * closeQty;
        const feeUsed = pos.fee * closeRatio;

        this.balance[exchange] += pnl + closeMargin - feeUse;      // 结算到余额

        /* ---------- 更新剩余仓位 ---------- */
        pos.qty -= closeQty;
        pos.margin -= closeMargin;
        pos.fee -= feeUsed;

        this.recordCompletedTrade(exchange, symbol, closeQty, pnl, feeUse + feeUsed, closeMargin);
        if (pos.qty <= 0.0000001) {

            delete this.positions[exchange][symbol];           // 全平
        } else {
            pos.entryPrice = pos.entryPrice;                   // 加权后已保持不变
        }
    }

    exitAll(exchange) {
        const exPos = Object.keys(this.positions?.[exchange] || {});
        for (const sym of exPos) this.exit(exchange, sym);   // 默认全部平
    }

    recordCompletedTrade(exchange, symbol, closeQty, pnl, fee, margin) {
        if (!this.tradeHistory) this.tradeHistory = [];

        const pos = this.positions?.[exchange]?.[symbol];
        if (!pos) return;

        const leverage = (pos.qty * pos.entryPrice) / pos.margin;
        const notionalValue = pos.qty * pos.entryPrice;

        this.tradeHistory.push({
            ts: new Date().toLocaleString(),
            exchange,
            symbol,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            exitPrice: this.checkRealPrice(exchange, symbol, pos.direction === 'LONG' ? 'bidPx' : 'askPx'),
            closeQty: closeQty,
            notionalValue: notionalValue,  // 实际持仓金额
            leverage: leverage,
            pnl: pnl,
            fee: fee,
            margin: margin,
            netReturnPct: ((pnl / margin) * 100)
        });
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
                    const netAsset = this.getTotalNetAsset(exchange); // 全部资产
                    const usedMargin = this.getUsedMargin(exchange);
                    const available = netAsset - usedMargin;
                    const marginRatio = (margin + pnl) / margin;

                    if (marginRatio <= (1 - RISK_MARGIN_RATIO)) {
                        console.warn(`[RISK][${exchange}][${symbol}] ${pos.direction} 已接近爆仓，净值比=${marginRatio.toFixed(4)}`);
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



    update() {
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
            this.riskDetectors();
        }

    }

    run() {
        setInterval(() => {
            this.tradingData = this.AM.getPriceMap();
            this.update();
            this.strategy();
        }, this.refreshInterval);
    }

    strategy() {
        const MAX_HOLD_SECONDS = 600;          // 持仓最长周期 (600秒 = 10分钟)
        const MAX_MARGIN_PER_POSITION = 200;  // 每个币种最多保证金投入（单位 USDT）
        const SPREAD_TARGET_MAX = 1.2;         // 最初目标是 1.2 × 初始spreadPctNet
        const SPREAD_TARGET_MIN = 0.8;         // 最终目标是 0.3 × 初始spreadPctNet
        const GOAL_NET_PCT = 0.005;              // 目标净收益率 0.002 （未百分比换算）

        const MAX_OPEN = 5;          // 最多并行币对
        const ENTRY_TH = 0.3;       // 开仓价差目标 0.30 (以百分比换算)
        const BASE_MARGIN = 100;        // 每次默认投入保证金（USDT）
        const LEVERAGE = 10;          // 初始杠杆（1 倍）

        const MIN_MARGIN = 5;    //最小的单次成交保证金额度金额；实际成交为MIN_MARGIN * LEVERAGE

        const minMargin = MIN_MARGIN * LEVERAGE

        if (!Object.keys(this.tradingData).length) return;

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


            if (this.getOpenPositionCount() >= MAX_OPEN) break; // 已达上限
            if (c.netPct < ENTRY_TH) break;                     // 后面的更低，直接截断

            const sym = c.symbol;
            // 如果此 symbol 已有双边仓位就跳过 (暂时不用)
            // if (this.positions.okx?.[sym] && this.positions.binance?.[sym]) continue;

            /* ---- 确定方向 & 可成交量 ---- */
            const okxLong = c.okxDirection; // true=>OKX做多
            const dirOkx = okxLong === 'LONG' ? 'LONG' : 'SHORT';
            const dirBin = okxLong === 'LONG' ? 'SHORT' : 'LONG';


            const marginOkx = this.positions.okx?.[sym]?.margin || 0;
            const marginBin = this.positions.binance?.[sym]?.margin || 0;
            const totalMargin = marginOkx + marginBin;

            if (totalMargin >= MAX_MARGIN_PER_POSITION) continue;

            // 买一/卖一可撮合 USDT 量
            const depthUsdt = okxLong
                ? Math.min(c.okxAsk * this.tradingData[c.symbol].okx.bidSz, c.binBid * this.tradingData[c.symbol].binance.bidSz)
                : Math.min(c.okxBid * this.tradingData[c.symbol].okx.bidSz, c.binAsk * this.tradingData[c.symbol].binance.askSz);

            // 实际下单金额 = 深度 / 杠杆
            const useMargin = Math.min(BASE_MARGIN, depthUsdt * 0.5 / LEVERAGE, this.getAvailableBalance('okx'), this.getAvailableBalance('binance'));
            if (useMargin < minMargin) continue;   // 太小的不做

            /* ---- 下单 ---- */
            this.entry('okx', sym, dirOkx, useMargin, LEVERAGE);
            this.entry('binance', sym, dirBin, useMargin, LEVERAGE);

            // const posOkx = this.positions?.okx?.[c.symbol];
            // const posBin = this.positions?.binance?.[c.symbol];

            // if (!posOkx || !posBin) {
            //     console.warn(`[ENTRY-CHECK] ${sym} 下单失败，缺失一腿，立即退出`);
            //     if (posOkx) this.exit('okx', sym);
            //     if (posBin) this.exit('binance', sym);
            //     continue;
            // }

            // const qtyOkx = posOkx.qty;
            // const qtyBin = posBin.qty;
            // const minQty = Math.min(qtyOkx, qtyBin);
            // const maxQty = Math.max(qtyOkx, qtyBin);
            // const mismatchRatio = (maxQty - minQty) / maxQty;

            // if (mismatchRatio > 0.01) {
            //     console.warn(`[ENTRY-CHECK] ${sym} 成交不一致，误差 ${(mismatchRatio * 100).toFixed(2)}%，立即平仓`);
            //     this.exit('okx', sym);
            //     this.exit('binance', sym);
            //     continue;
            // }




            // console.log(`[ENTRY] ${sym}  OKX:${dirOkx}  BIN:${dirBin}  margin=${useMargin}`);
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

            this.goalNet[symbol] = (goalNetPct + 1) * (posBin.margin + posOkx.margin) - (posBin.margin + posOkx.margin);

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
                this.exit('okx', symbol, closeAmountUSDT);
                this.exit('binance', symbol, closeAmountUSDT);
            }
        }

    }

}



function main() {
    const tc = new TradingControl(view = false);
    tc.run();
}

main();
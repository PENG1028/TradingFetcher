// config/start.config.js
module.exports = {
    proxy: 'http://127.0.0.1:7890/',

    enabled: true, // ✅ 启动开关，false = 完全不运行
    
    tasks: {
      history: true,         // 启动历史数据获取模块
      restRealtime: true,    // 启动 REST 实时更新模块
      wsRealtime: false      // 启动 WebSocket Tick 数据监听模块
    },
  
    market: {
        
        crypto: {
            exchanges: ['okx','binance'],
            defaultType: ['swap'], // spot：现货；swap：永续合约；future：交割合约；option：期权
            quoteAsset: 'USDT',
            timeframes: ['1m','5m'],
            since: null, // since为ALL时则获取所有交易所已有历史数据；不为ALL时获取从现在到 since的所有数据
            limits: 3000, // 获取自当前 n 个 k 线的数据；limits 权重小于 since 当 since 不为 null 时以 since 为准
            symbols: ['BTC/USDT'] // 当 symbols 为 ALL 时则获取所有交易所对象
        }
        
      
    },
  
    rest: {
      intervalSeconds: 60,   // 每隔 N 秒轮询一次每个 symbol
      writeToDB: true        // 是否写入 ohlcv_data
    },
  
    ws: {
      saveToDB: true         // 是否写入 tick_data 表
    },
  
    dbPath: '../data/marketData.db'
  };
  
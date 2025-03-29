const AShareFetcher = require('../core/fetchers/AShareFetcher.js');

// 使用示例
(async () => {
  const fetcher = new AShareFetcher({
    maxLiquidity: 500, // 只交易流动性前500的股票
    pythonPath: 'python' // 根据实际Python路径修改
  });
  try {
    // 获取沪深300成分股数据
    const data = await fetcher.fetchSymbol('sh:600000', '1d', {
      start: new Date('2023-01-01'),
      end: new Date('2023-01-05')
    });
    
    console.log('示例数据:', data[0]);
    /* 输出结构：
    {
      timestamp: 1672531200000,
      open: 10.5,
      high: 10.8,
      low: 10.3,
      close: 10.6,
      volume: 15678900,
      _market: 'sh',
      _liquidity: 15.6,
      _type: 'ashare'
    }
    */
  } catch (error) {
    console.error('获取失败:', error);
  }
})();
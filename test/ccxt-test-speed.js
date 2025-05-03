// test/autoThrottleTest.js
const ccxt = require('ccxt');
const limiterManager = require('../core/limiterManager');

const symbol = 'BTC/USDT';
const exchangeId = 'okx';  // 或 binance
const config = require("../config/start.config.js")
const exchange = new ccxt['bitget']({
            enableRateLimit: false,
            timeout: 3000,
            httpProxy: config.proxy || undefined,  // 防止空字符串
            options: {
                defaultType: 'spot'  
            }
        });
        async function autoTest() {
          let rps = 5;
          const maxConcurrency = 10;
          let successCount = 0;
        
          console.log(`[测试] 开始自动频率测试，初始RPS=${rps}`);
        
          while (true) {
            console.log(`\n[阶段] 尝试 RPS=${rps}`);
        
            limiterManager.init(exchangeId, maxConcurrency, rps);
            const limiter = limiterManager.get(exchangeId).getRestLimiter();
        
            const batchSize = 30;
            const promises = [];
            let failed = false;
        
            for (let i = 0; i < batchSize; i++) {
              promises.push(
                limiter(async () => {
                  try {
                    await exchange.fetchOHLCV(symbol);  // 可替换为 fetchOHLCV
                    successCount++;
                  } catch (err) {
                    failed = true;
                    console.error(`[❌] 请求失败: ${err.message}`);
                  }
                })
              );
            }
        
            await Promise.all(promises);
        
            if (failed) {
              console.log(`\n[结果] 达到速率上限：RPS=${rps - 1}（成功 ${successCount} 次）`);
              break;
            }
        
            rps += 5;  // 每次递增RPS步长
            await new Promise(res => setTimeout(res, 3000)); // 稍微等待后再尝试
          }
        }
        
        autoTest();
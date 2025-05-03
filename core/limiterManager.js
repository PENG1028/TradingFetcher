// core/limiterManager.js
const pLimit = require('p-limit').default;
const pThrottle = require('p-throttle').default;


class ExchangeLimiter {
    constructor(exchangeId, totalConcurrency = 10, requestsPerSecond = 10) {
      this.exchangeId = exchangeId;
      this.totalConcurrency = totalConcurrency;
      this.requestsPerSecond = requestsPerSecond;
      this.loaderActive = false;
  
      const loaderLimit = pLimit(Math.floor(totalConcurrency * 0.7));
      const restLimit = pLimit(totalConcurrency - Math.floor(totalConcurrency * 0.7));
  
      // ✅ throttle 封装整个任务队列（不针对 fn 单独包裹）
      this.restThrottle = pThrottle({
        limit: requestsPerSecond,
        interval: 1000
      })(async (fn) => fn());
  
      this.loaderLimiter = (fn) => loaderLimit(() => this.restThrottle(fn));
      this.restLimiter = (fn) => restLimit(() => this.restThrottle(fn));
    }
  
    getLoaderLimiter() {
        console.log(`[LIMITER] 启动 LoaderLimiter ${this.exchangeId}`)
      this.loaderActive = true;
      return this.loaderLimiter;
    }
  
    getRestLimiter() {
      return this.loaderActive
        ? this.restLimiter
        : (fn) => pLimit(this.totalConcurrency)(() => this.restThrottle(fn));
    }
  
    markLoaderDone() {
      this.loaderActive = false;
      console.log(`[LIMITER] ${this.exchangeId} Loader 完成 -> RestUpdater 接管 ${this.totalConcurrency} 并发`);
    }
  }

class LimiterManager {
  constructor() {
    this.limiters = new Map();
  }

  init(exchangeId, totalConcurrency = 10, requestsPerSecond = 10) {
    if (!this.limiters.has(exchangeId)) {
      this.limiters.set(exchangeId, new ExchangeLimiter(exchangeId, totalConcurrency, requestsPerSecond));
    }
    
  }

  get(exchangeId) {
    return this.limiters.get(exchangeId);
  }

  finishLoader(exchangeId) {
    const limiter = this.get(exchangeId);
    if (limiter) limiter.markLoaderDone();
  }
}

module.exports = new LimiterManager();

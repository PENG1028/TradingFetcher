// File: AShareFetcher.js
import { spawn } from 'child_process';
import { BaseFetcher } from './BaseFetcher.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AShareFetcher extends BaseFetcher {
    constructor(config = {}) {
        super({
            batchSize: 8,  // 优化后的Python进程吞吐量
            maxRetry: 3,
            rateLimit: {
                concurrency: 4,  // 根据1核优化
                batchDelay: 1500 
            },
            maxLiquidity: 1000,  // 新增配置项
            ...config
        });

        this.liquidityCache = new Map();
        this.marketMap = new Map([
            ['sh', { prefix: 'sh', name: '沪市' }],
            ['sz', { prefix: 'sz', name: '深市' }],
            ['bj', { prefix: 'bj', name: '北交所' }]
        ]);
    }

    async loadAllSymbols() {
        if (this.config.symbols) {
            this.symbols = new Set(this._validateSymbols(this.config.symbols));
            return;
        }

        // 全量获取模式
        const rawList = await this._execPythonProcess([
            path.join(__dirname, 'akshare_loader.py'),
            'symbols'
        ]);

        // 流动性排序逻辑
        const sorted = rawList
            .filter(item => item.trade_date === this._lastTradeDate())
            .sort((a, b) => b.turnover_rate - a.turnover_rate);

        // 应用流动性过滤
        this.symbols = new Set(
            sorted.slice(0, this.config.maxLiquidity)
                 .map(item => this._convertSymbol(item.symbol))
        );

        // 建立流动性缓存
        sorted.forEach(item => {
            this.liquidityCache.set(item.symbol, item.turnover_rate);
        });
    }

    // 修复fetchSymbol方法
  async fetchSymbol(symbol, timeframe, { start, end }) {
    const [market, code] = symbol.split(':');
    const args = [
      path.join(__dirname, 'akshare_loader.py'),
      'ohlcv',
      `${market}${code}`,
      timeframe || '1d',  // 添加默认值
      start ? this._formatDate(start) : '',
      end ? this._formatDate(end) : ''
    ].filter(arg => arg !== '');  // 严格过滤空参数
    try {
      const rawData = await this._execPythonProcess(args);
      return this._transformData(rawData);
    } catch (e) {
      throw new Error(`获取${symbol}失败: ${e.message}`);
    }
  }

    // 新增流动性元数据
    normalize(ohlcv) {
        return {
            ...super.normalize(ohlcv),
            _market: ohlcv._raw.symbol.split(':')[0],
            _liquidity: this.liquidityCache.get(ohlcv._raw.symbol) || 0,
            _type: 'ashare'
        };
    }

    // 私有方法优化
    _convertSymbol(akSymbol) {
        const market = akSymbol.startsWith('6') ? 'sh' : 
                     akSymbol.startsWith(['0','3']) ? 'sz' : 'bj';
        return `${market}:${akSymbol}`;
    }

    _lastTradeDate() {
        // 实现交易日缓存逻辑
        return new Date().toISOString().slice(0,10).replace(/-/g,'');
    }

    _transformData(raw) {
        if (!Array.isArray(raw)) {
          throw new Error('无效数据格式: 预期数组类型');
        }
        
        return raw
          .map(item => {
            try {
              return [
                new Date(item.date + ' 15:00+08:00').getTime(), // 添加A股收盘时间
                parseFloat(item.open),
                parseFloat(item.high),
                parseFloat(item.low),
                parseFloat(item.close),
                parseFloat(item.volume)
              ];
            } catch (e) {
              console.warn('数据格式异常:', item);
              return null;
            }
          })
          .filter(item => item !== null);
      }

    _formatDate = (date) => {
        if (!(date instanceof Date)) {
          throw new Error('无效的日期对象');
        }
        return date.toISOString().split('T')[0].replace(/-/g, '');
      }
      // 更新fetchSymbol参数处理
      async fetchSymbol(symbol, timeframe, { start, end }) {
        const [market, code] = symbol.split(':');
        const args = [
          path.join(__dirname, 'akshare_loader.py'),
          'ohlcv',
          `${market}${code}`,
          timeframe || '1d',
          start ? this._formatDate(start) : 'null',  // 使用null占位符
          end ? this._formatDate(end) : 'null'
        ].filter(arg => arg !== 'null');  // 过滤无效占位符
      }

    // 修改2：增强参数处理逻辑
    _buildPythonArgs(market, symbol, timeframe, dateRange) {
        return [
          path.join(__dirname, 'akshare_loader.py'),
          'history',
          market?.toUpperCase() || 'SH',
          symbol,
          timeframe,
          dateRange?.start ? this._formatDate(dateRange.start) : '',
          dateRange?.end ? this._formatDate(dateRange.end) : ''
        ].filter(arg => arg !== '');
      }

      // 新增核心方法 (必须存在于子类)
      _execPythonProcess = (args) => {
        return new Promise((resolve, reject) => {
          const pyProcess = spawn(this.config.pythonPath || 'python', args, {
            shell: true,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
          });
          let stdout = '';
          let stderr = '';
          
          pyProcess.stdout.on('data', (d) => stdout += d);
          pyProcess.stderr.on('data', (d) => stderr += d);
          pyProcess.on('close', (code) => {
            try {
              const result = JSON.parse(stdout);
              if (result.status === 'error') {
                throw new Error(`Python异常: ${result.message}\n${result.traceback}`);
              }
              resolve(result.data);
            } catch (e) {
              const errorMessage = [
                `Python进程异常(code ${code})`,
                `STDOUT: ${stdout.slice(0,500)}`,
                `STDERR: ${stderr.slice(0,500)}`
              ].join('\n');
              reject(new Error(errorMessage));
            }
          });
        });
      }

      async validateEnvironment() {
        try {
          const testResult = await this._execPythonProcess([
            '-c', 
            'import akshare; print(akshare.__version__)'
          ]);
          console.log(`✅ 环境验证通过 - akshare v${testResult}`);
          return true;
        } catch (e) {
          console.error('❌ 环境验证失败:');
          console.error(e.message);
          return false;
        }
      }

}
  

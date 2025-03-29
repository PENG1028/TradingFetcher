const { CryptoSpotFetcher } = require('../core/fetchers/CryptoSpot.js');
const { inspect } = require('util');
const fs = require('fs/promises');
const path = require('path');


// CSV生成器类
class CsvWriter {
    static async save(dataMap, outputDir = './output') {
        await fs.mkdir(outputDir, { recursive: true })
        
        const versionTag = Math.random().toString(36).substring(2, 8) // 修正substr为substring
        
        for (const [symbol, records] of dataMap) {
          // 增加数据校验
          if (!Array.isArray(records)) {
            console.error(`无效数据格式: ${symbol} 对应的数据不是数组`)
            continue;
          }
          const sanitizedSymbol = symbol.replace('/', '-')
          const filename = `${sanitizedSymbol}_${versionTag}.csv`
          
          // 修复路径处理
          const filepath = path.resolve(outputDir, filename)
          
          await this.cleanPreviousVersions(sanitizedSymbol, outputDir)
          // 修复map回调函数缺失的问题
          const rows = records.map(record => {
            // 增加字段存在性检查
            if (!record.ts || typeof record.open === 'undefined') {
              console.warn(`发现无效记录: ${symbol} ${record.ts || '无时间戳'}`)
              return null
            }
            return [
              new Date(record.ts).toISOString(),
              record.open,
              record.high,
              record.low,
              record.close,
              record.volume
            ].join(',')
          }).filter(Boolean).join('\n') // 过滤空行
          
          try {
            await fs.writeFile(filepath, 'timestamp,open,high,low,close,volume\n' + rows)
            console.log(`成功写入 ${symbol} 数据 (${records.length}条)`)
          } catch (err) {
            console.error(`写入失败 [${symbol}]:`, err.message)
          }
        }
      }
    // 清理历史版本文件
    static async cleanPreviousVersions(symbolPattern, dirPath) {
      try {
        const files = await fs.readdir(dirPath)
        const oldFiles = files.filter(f => f.startsWith(symbolPattern))
        
        await Promise.all(
          oldFiles.map(file => 
            fs.unlink(path.join(dirPath, file))
        ))
      } catch (err) {
        console.error('清理旧文件失败:', err.message)
      }
    }
  }


const test = async () => {
  
    const fetcher = new CryptoSpotFetcher('binance', {
        batchSize: 5,         // 覆盖默认配置
        symbols: [],
        quoteAsset: 'USDT',
        maxLiquidity: 5,
        timeout: 30000,
        proxy: 'http://127.0.0.1:7890' // 添加代理配置
    });

    const data = await fetcher.fetchData('5m', {
        since: Date.now() - 3600_000*8,
        limit: 1000
    });

    // console.log(inspect(data, { depth: 6, colors: true })) //显示_raw [Array] 详细信息
    console.log(data);
    await CsvWriter.save(data, './crypto_data')
};
test().catch(console.error);
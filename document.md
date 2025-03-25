# 项目架构设计 v2.1

## 核心模块
├── config
│   └── RateLimitConfig.js  # 各交易所API速率限制配置
├── core
│   └── fetchers            # 数据获取器实现
│       ├── BaseFetcher.js  # 抽象基类（定义通用接口）
│       ├── AShareFetcher.js # A股数据获取（基于AKShare）
│       └── CryptoSpot.js   # 加密货币现货数据（基于CCXT）
├── scripts
│   └── akshare_handler.py  # AKShare数据获取脚本
└── test
    ├── test-stock.js       # A股测试用例
    └── test-crypto.js      # 加密货币测试

## 已实现特性
### 数据获取

- **加密货币市场**  
  采用CCXT库（Node.js原生集成）支持：
  - 现货市场实时行情
  - 1m/5m/15m K线粒度
  - 自动处理交易所差异

### 核心机制
1. **速率控制**  
   动态调整请求频率，遵守交易所API限制（RateLimitConfig）

2. **数据标准化**  
   统一输出格式：
   ```js
   {
     timestamp: 1711356780,
     open: 32500.5,
     high: 32580.2,
     low: 32490.1, 
     close: 32545.3,
     volume: 2.54
   }
   ```

3. **错误处理**  
   自动重试机制（指数退避算法）

## 当前限制与待实现功能

### 已知问题
1. AKShare Python服务偶发连接中断需手动重启
2. CCXT高频请求时内存占用增长较快
3. 时区处理未统一（部分交易所返回UTC时间）

### 规划中的功能
- [ ] 实时数据WebSocket支持
- [ ] 多交易所数据聚合
- [ ] 异常检测告警模块
- [ ] 数据质量监控面板

## 免责声明

⚠️ **实验性项目警告**  
本项目处于早期开发阶段，尚未达到生产可用状态。使用者应知悉：
1. 数据获取的稳定性和完整性无法保证
2. 部分交易所接口可能随时失效
3. 请勿用于实际交易决策
4. 开发者不对数据准确性承担责任

## 依赖库
- `ccxt@2.7.7` - 加密货币交易所统一API
- `akshare` - A股市场数据获取（Python端）
- `node-schedule` - 任务调度
- `lodash` - 数据处理工具

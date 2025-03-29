# TradingFetcher 交易采集者 (实验性项目-开发中)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Progress](https://img.shields.io/badge/完成度-5%25-orange)](https://github.com/yourusername/tradingfetcher)

⚠️ **新手开发者警告**  
本人作为自学编程新手，正在尝试构建一个历史交易数据系统。目前仅部分功能可用，请谨慎使用！

## 当前状态
✅ **已完成**
- 加密货币现货数据获取（CCXT实现）
- 基础速率限制控制
- 简单的数据格式化

❌ **未完成**
- 股市数据获取不稳定（AKShare对接问题）
- 数据库接入尚未实现
- 回测框架缺失
- 错误处理机制不完善

## 项目架构
```bash
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
```

## 急需更新
1. 🚧 股市数据获取 - AKShare接口无法正常使用，返回空数据
2. 🛠️ 数据库接入 - 完全未开始，需要轻量级方案预计使用SQLite
3. 📉 回测框架 - 仅停留在概念阶段
4. 🚨 错误处理 - 当前直接崩溃无错误恢复

## 免责声明
本程序可能存在严重缺陷，可能导致：
- 数据不准确/不完整
- 意外崩溃或数据丢失
- 交易所API滥用封禁

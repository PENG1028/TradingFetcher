# 文件架构设计

├── config
│   ├── markets.js         # 市场配置
│   ├── symbols.js         # 品种清单
│   ├── RateLimitConfig.js # 各数据源获取速率限制
│   └── config.js          # 新增启动配置
├── core
│   ├── fetchers           # 数据获取器
│   │   ├── BaseFetcher.js # 抽象基类
│   │   ├── AShare.js      # A股获取
│   │   ├── CryptoSpot.js  # 虚拟币现货
│   │   └── OKXFuture.js   # OKX合约
│   ├── processors         # 数据处理
│   │   ├── TimeAlign.js   # 时间对齐
│   │   └── Normalizer.js  # 数据标准化
│   └── aggregators        # 新增数据聚合器
│   └── writers            # 数据写入
│       └── Timescale.js   # 时序数据库
├── scripts                # 新增脚本目录
│   └── history_fill.js    # 历史数据补全脚本
├── services
│   ├── RetryManager.js    # 智能重试
│   ├── Monitor.js         # 监控服务
│   └── Scheduler.js       # 任务调度
├── utils
│   ├── signature.js       # API签名
│   └── time.js            # 时间工具
├── test                   # 测试文件
│   └── ...
└── index.js               # 主入口

# 当前的问题
- 使用什么样的获取机制，获取k线级别
- A股和虚拟币市场的现货类型选用什么库或api调用
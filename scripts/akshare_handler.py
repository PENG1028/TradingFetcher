# File: akshare_loader.py
import sys
import akshare as ak
import json
import datetime

def get_all_ashare():
    """获取全量A股列表及流动性指标"""
    df = ak.stock_zh_a_spot_em()
    return df[['代码', '换手率', '成交量', '最新价']].rename(columns={
        '代码': 'symbol',
        '换手率': 'turnover_rate',
        '成交量': 'volume',
        '最新价': 'price'
    }).to_dict('records')

def get_ohlcv(symbol, start, end):
    """获取历史行情数据"""
    # 增加代码格式校验
    if not symbol.isdigit():
        raise ValueError(f"无效股票代码格式: {symbol}，示例正确格式: 600000")
    
    df = ak.stock_zh_a_hist(symbol=symbol, period="daily", 
                          start_date=start, end_date=end)
    # 处理空数据情况
    if df.empty:
        return []
    return df.rename(columns={
        '日期': 'date',
        '开盘': 'open',
        '最高': 'high',
        '最低': 'low',
        '收盘': 'close',
        '成交量': 'volume'
    }).to_dict('records')

if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        
        if mode == 'symbols':
            data = get_all_ashare()
        elif mode == 'ohlcv':
            symbol = sys.argv[2]
            timeframe = sys.argv[3]
            start = sys.argv[4] if len(sys.argv)>=5 and sys.argv[4] != 'null' else None
            end = sys.argv[5] if len(sys.argv)>=6 and sys.argv[5] != 'null' else None
            data = get_ohlcv(symbol, start, end)
        
        print(json.dumps({
            "status": "success",
            "data": data
        }))
    except Exception as e:
        print(json.dumps({
            "status": "error",
            "message": str(e),
            
        }))
        sys.exit(1)

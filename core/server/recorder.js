const fs   = require('fs');
const path = require('path');
const day  = () => new Date().toISOString().slice(0, 10); // 2025-05-06

// 每天一个独立文件（positions / orders / ws）
function openStream(type){
  const dir = './records';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `${type}-${day()}.log`);
  return fs.createWriteStream(file, { flags: 'a' });
}

let streams = {};
function write(type, payload){
  if (!streams[type] || day() !== streams[type].date){
    if (streams[type]) streams[type].end();
    streams[type] = openStream(type);
    streams[type].date = day();
  }
  streams[type].write(JSON.stringify(payload) + '\n');
}

module.exports = {
  /** 记录持仓快照 */
  positionSnap(pos){              // pos 为你现有的对象结构
    write('positions', { ts: Date.now(), ...pos });
  },

  /** 记录下单结果 */
  orderResult(res){               // res.success / res.error / res.id ...
    write('orders', { ts: Date.now(), ...res });
  },

  /** 记录 WS 事件 */
  wsEvent(evt, extra){            // evt: 'reconnect' / 'close' / 'error'
    write('ws', { ts: Date.now(), evt, ...extra });
  }
};

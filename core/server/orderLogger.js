// core/server/orderLogger.js
const fs = require('fs');
const path = require('path');

class OrderLogger {
    constructor(logPath = path.join(__dirname, '../../data/logs/order.log')) {
        this.logFile = path.resolve(logPath);
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    }

    log({ exchange, symbol, direction, isClose, amount, result, error = null, ms }) {
        const timestamp = new Date().toISOString();
        const msg = {
            time: timestamp,
            exchange,
            symbol,
            side: `${isClose ? 'close' : 'entry'}-${direction}`,
            amount,
            result,
            duration_ms: ms,
            error: error ? error.toString() : null
        };
        const line = JSON.stringify(msg) + '\n';
        fs.appendFileSync(this.logFile, line);
        // console.log('[LOGGER] writing to', this.logFile);
    }
}

module.exports = new OrderLogger();

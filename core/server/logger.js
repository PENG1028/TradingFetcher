const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

module.exports = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message, ...meta }) =>
      JSON.stringify({ ts: timestamp, level, msg: message, ...meta }))
  ),
  transports: [
    new transports.Console(),
    new transports.DailyRotateFile({
      dirname  : './logs',
      filename : 'app-%DATE%.log', // 例：app-2025-05-06.log
      maxFiles : '30d'
    })
  ]
});

const nodemailer = require('nodemailer');
const logger     = require('./logger');

const transporter = nodemailer.createTransport({
  host  : process.env.SMTP_HOST,
  port  : process.env.SMTP_PORT || 465,
  secure: true,
  auth  : { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

let last = 0, cache = '';
exports.send = async (subject, msg) => {
  // 10 min 节流 + 去重
  if (msg === cache && Date.now() - last < 600_000) return;
  cache = msg; last = Date.now();
  try {
    await transporter.sendMail({
      from: `"TraderBot" <${process.env.SMTP_USER}>`,
      to  : process.env.ALERT_TO,
      subject,
      text: msg
    });
    logger.warn(`[Alert] 邮件已发送：${subject}`);
  } catch (err) {
    logger.error(`[Alert] 发送失败 ${err.message}`);
  }
};

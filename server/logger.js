const fs = require('fs');
const { TASK_DIR, LOG_FILE } = require('./config');

function log(level, message, context = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  try {
    fs.mkdirSync(TASK_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch (error) {
    console.error('log_write_failed', error.message);
  }
  console.log(line);
}

function resetRuntimeLog(reason, context = {}) {
  try {
    fs.mkdirSync(TASK_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  } catch (error) {
    console.error('log_reset_failed', error.message);
  }
  log('info', 'runtime_log_reset', { reason, ...context });
}

module.exports = { log, resetRuntimeLog };

const { spawnSync } = require('child_process');
const path = require('path');
const { SEMANTIC_CACHE_DB } = require('./config');

function createSemanticCache({ log }) {
  const script = path.join(__dirname, 'semantic_cache.py');

  function run(command, payload) {
    const python = process.env.PYTHON_BIN || 'python';
    const result = spawnSync(python, [script, SEMANTIC_CACHE_DB, command], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    if (result.stderr) {
      log('warn', 'semantic_cache_stderr', { command, stderr: result.stderr.slice(0, 500) });
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`语义缓存命令失败: ${command} (${result.status}) ${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}');
    if (!parsed.ok) throw new Error(parsed.error || '语义缓存返回失败');
    return parsed.data || {};
  }

  function lookup({ domain, taxonomyVersion, promptVersion, keys }) {
    return run('lookup', { domain, taxonomyVersion, promptVersion, keys });
  }

  function upsert({ domain, taxonomyVersion, promptVersion, model, source, mappings }) {
    return run('upsert', { domain, taxonomyVersion, promptVersion, model, source, mappings });
  }

  return { lookup, upsert };
}

module.exports = { createSemanticCache };

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const TOOL_SCRIPT = path.join(ROOT, 'server', 'excel_tools.py');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function runTool(filePath, toolName, args) {
  const result = spawnSync(PYTHON_BIN, [TOOL_SCRIPT, filePath, toolName, JSON.stringify(args)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${toolName} 失败，退出码 ${result.status}`);
  }
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}');
  if (!payload.ok) throw new Error(payload.error || `${toolName} 返回失败`);
  return payload.data;
}

function main() {
  const filePath = path.resolve(ROOT, argValue('--file', path.join('samples', 'demo-ledger.csv')));
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  console.log(JSON.stringify({ python: PYTHON_BIN, filePath }, null, 2));

  const described = runTool(filePath, 'excel_describe_workbook', {});
  if (!described.sheets?.length) throw new Error('describe 未返回工作表');

  const searched = runTool(filePath, 'excel_search', { query: '银行', maxResults: 5 });
  if (!Number.isInteger(searched.resultCount)) throw new Error('search 未返回 resultCount');

  const rows = runTool(filePath, 'excel_read_rows', { startRow: 1, endRow: 3 });
  if (rows.rows?.length !== 3) throw new Error('read_rows 行数不符合预期');

  console.log('excel tools smoke passed');
}

main();

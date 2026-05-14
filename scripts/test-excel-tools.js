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

function runPython(args) {
  const result = spawnSync(PYTHON_BIN, [TOOL_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`excel_tools.py 失败，退出码 ${result.status}`);
  }
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}');
  if (!payload.ok) throw new Error(payload.error || 'excel_tools.py 返回失败');
  return payload.data;
}

function buildIndex(filePath, indexDir) {
  return runPython(['build-index', filePath, indexDir]);
}

function runTool(indexDir, toolName, args) {
  return runPython(['tool', indexDir, toolName, JSON.stringify(args)]);
}

function main() {
  const filePath = path.resolve(ROOT, argValue('--file', path.join('samples', 'demo-ledger.csv')));
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const indexDir = path.resolve(ROOT, argValue('--index-dir', path.join('.agentic-tasks', 'excel-tools-smoke-index')));
  console.log(JSON.stringify({ python: PYTHON_BIN, filePath, indexDir }, null, 2));

  const manifest = buildIndex(filePath, indexDir);
  if (!manifest.sheets?.length) throw new Error('build-index 未返回工作表');

  const listed = runTool(indexDir, 'excel_list_sheets', {});
  if (!listed.sheets?.length) throw new Error('excel_list_sheets 未返回工作表');

  const schema = runTool(indexDir, 'excel_get_schema', {});
  if (!schema.columns?.length) throw new Error('excel_get_schema 未返回列');

  const searched = runTool(indexDir, 'excel_search', { query: '银行', maxResults: 5 });
  if (!Number.isInteger(searched.resultCount)) throw new Error('search 未返回 resultCount');

  const rows = runTool(indexDir, 'excel_read_rows', { startRow: 1, endRow: 3 });
  if (rows.rows?.length !== 3) throw new Error('read_rows 行数不符合预期');

  const aggregate = runTool(indexDir, 'excel_aggregate', { column: '金额', operation: 'sum' });
  if (!aggregate.rows?.length) throw new Error('aggregate 未返回结果');

  console.log('excel tools smoke passed');
}

main();

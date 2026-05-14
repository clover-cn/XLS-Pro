const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const DATA_DIR = path.join(ROOT, 'data');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const TASK_DIR = resolveProjectPath(process.env.TASK_STORAGE_DIR || '.agentic-tasks');
const FILES_DIR = path.join(TASK_DIR, 'files');
const TASKS_DIR = path.join(TASK_DIR, 'tasks');
const LOG_FILE = path.join(TASK_DIR, 'server-runtime.log');
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3100);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS || 60000);
const REPAIR_LIMIT = 3;
const AGENT_TOOL_CALL_LIMIT = 20;
const AGENT_TOOL_CALLS_PER_ROUND = 3;
const AGENT_FORCE_FINAL_REMAINING = 1;
const EXCEL_TOOL_TIMEOUT_MS = Number(process.env.EXCEL_TOOL_TIMEOUT_MS || 30000);
const WORKBOOK_INDEX_TIMEOUT_MS = Number(process.env.WORKBOOK_INDEX_TIMEOUT_MS || 10 * 60 * 1000);
const TASK_CACHE_TTL_MS = Number(process.env.TASK_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const TERMINAL_STATES = new Set(['completed', 'failed', 'needs_clarification', 'cancelled']);
const ACTIVE_STATES = new Set([
  'uploaded',
  'metadata_ready',
  'indexing',
  'retrieving_rules',
  'exploring_data',
  'generating_code',
  'executing',
  'repairing',
]);

const tasks = new Map();
const clients = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TASK_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(TASKS_DIR, { recursive: true });
log('info', 'server_configured', {
  port: PORT,
  taskDir: TASK_DIR,
  filesDir: FILES_DIR,
  tasksDir: TASKS_DIR,
  cacheTtlHours: Math.round(TASK_CACHE_TTL_MS / 3600000),
  model: process.env.OPENAI_MODEL || '',
  hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  pythonBin: process.env.PYTHON_BIN || 'python',
});
cleanupOldTaskCache();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

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

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function directorySize(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return fs.readdirSync(targetPath).reduce((total, entry) => total + directorySize(path.join(targetPath, entry)), 0);
}

function removeTaskCachePath(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved === path.resolve(TASK_DIR) || !isPathInside(TASK_DIR, resolved)) {
    throw new Error(`拒绝删除任务缓存目录外路径: ${targetPath}`);
  }
  const bytes = directorySize(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
  return bytes;
}

function touchIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const now = new Date();
  fs.utimesSync(targetPath, now, now);
}

function removeStaleChildren(baseDir, cutoffMs, protectedNames = new Set()) {
  if (!fs.existsSync(baseDir)) return { removed: 0, freedBytes: 0 };
  let removed = 0;
  let freedBytes = 0;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (protectedNames.has(entry.name)) continue;
    const fullPath = path.join(baseDir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs >= cutoffMs) continue;
    freedBytes += removeTaskCachePath(fullPath);
    removed += 1;
  }
  return { removed, freedBytes };
}

function cleanupOldTaskCache() {
  try {
    fs.mkdirSync(FILES_DIR, { recursive: true });
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const cutoffMs = Date.now() - TASK_CACHE_TTL_MS;
    const protectedRootNames = new Set(['files', 'tasks', path.basename(LOG_FILE)]);
    const files = removeStaleChildren(FILES_DIR, cutoffMs);
    const taskRuns = removeStaleChildren(TASKS_DIR, cutoffMs);
    const legacy = removeStaleChildren(TASK_DIR, cutoffMs, protectedRootNames);
    log('info', 'task_cache_cleanup_finished', {
      ttlHours: Math.round(TASK_CACHE_TTL_MS / 3600000),
      removed: files.removed + taskRuns.removed + legacy.removed,
      freedBytes: files.freedBytes + taskRuns.freedBytes + legacy.freedBytes,
      filesRemoved: files.removed,
      taskRunsRemoved: taskRuns.removed,
      legacyRemoved: legacy.removed,
    });
  } catch (error) {
    log('warn', 'task_cache_cleanup_failed', { error: error.message });
  }
}

function appendTaskLog(task, type, payload = {}) {
  if (!task.dir) return;
  const safePayload = { ...payload };
  if (safePayload.task) {
    safePayload.task = {
      id: safePayload.task.id,
      state: safePayload.task.state,
      message: safePayload.task.message,
      outputReady: safePayload.task.outputReady,
    };
  }
  if (safePayload.code) {
    safePayload.code = `[python code ${safePayload.code.length} chars]`;
  }
  if (safePayload.result) {
    safePayload.result = summarizeToolResult(safePayload.result);
  }
  const line = JSON.stringify({
    at: new Date().toISOString(),
    type,
    state: task.state,
    message: payload.message || '',
    payload: safePayload,
  });
  try {
    fs.appendFileSync(path.join(task.dir, 'task.log'), `${line}\n`, 'utf8');
  } catch (error) {
    log('error', 'task_log_write_failed', { taskId: task.id, error: error.message });
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(req) {
  return readBody(req, 2 * 1024 * 1024).then((buffer) => {
    if (!buffer.length) return {};
    return JSON.parse(buffer.toString('utf8'));
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const rawHeaders = buffer.slice(start, headerEnd).toString('utf8');
    let content = buffer.slice(headerEnd + 4, next);
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
      content = content.slice(0, -2);
    }
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(rawHeaders);
    const name = disposition && /name="([^"]+)"/i.exec(disposition[1]);
    const filename = disposition && /filename="([^"]*)"/i.exec(disposition[1]);
    const type = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    parts.push({
      name: name ? name[1] : '',
      filename: filename ? path.basename(filename[1]) : '',
      contentType: type ? type[1].trim() : '',
      content,
    });
    start = next;
  }
  return parts;
}

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return [];
  return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
}

function scoreRule(rule, text) {
  const haystack = text.toLowerCase();
  const tokens = [
    rule.condition,
    rule.action,
    ...(Array.isArray(rule.tags) ? rule.tags : []),
  ].join(' ').toLowerCase().split(/[\s,，、=：:->]+/).filter(Boolean);
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function retrieveRules(metadata, requirement, temporaryRules) {
  const text = [
    requirement,
    temporaryRules,
    ...(metadata.columns || []).map((column) => `${column.name} ${column.type}`),
    ...(metadata.rawRows || []).flatMap((row) => row.values || []),
  ].join(' ');
  return loadRules()
    .map((rule) => ({ ...rule, score: scoreRule(rule, text) }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function inferType(values) {
  const filtered = values.filter((value) => value !== '');
  if (!filtered.length) return 'empty';
  if (filtered.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return 'number';
  if (filtered.every((value) => !Number.isNaN(Date.parse(value)))) return 'date';
  return 'text';
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function extractCsvMetadata(filePath, previewRows = 3) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const rawRows = lines.slice(0, previewRows).map((line, index) => ({
    rowNumber: index + 1,
    values: parseCsvLine(line),
  }));
  const headerIndex = rawRows.length > 1
    ? rawRows.reduce((best, row, index) => (row.values.filter(Boolean).length > rawRows[best].values.filter(Boolean).length ? index : best), 0)
    : 0;
  const headers = rawRows[headerIndex]?.values || parseCsvLine(lines[0] || '');
  const rows = lines.slice(1).map(parseCsvLine);
  return {
    fileKind: 'csv',
    sheetName: 'CSV',
    sheetNames: ['CSV'],
    totalRows: rows.length,
    totalColumns: headers.length,
    previewRows,
    rawRows,
    mergedCells: [],
    detectedHeaderRowNumber: headerIndex + 1,
    columns: headers.map((header, index) => ({
      name: header || `Column ${index + 1}`,
      type: inferType(rows.slice(0, 50).map((row) => row[index] || '')),
    })),
  };
}

function extractXlsxMetadata(filePath, previewRows = 3) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN || 'python';
    const script = path.join(__dirname, 'xlsx_metadata.py');
    const child = spawn(python, [script, filePath, String(previewRows)], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || 'XLSX 元数据解析失败'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function extractMetadata(filePath, filename, previewRows = 3) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') return extractCsvMetadata(filePath, previewRows);
  if (ext === '.xlsx') return extractXlsxMetadata(filePath, previewRows);
  throw new Error('仅支持 .csv 和 .xlsx 文件');
}

function publish(task, type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  task.events.push(event);
  appendTaskLog(task, type, payload);
  log(type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info', 'task_event', {
    taskId: task.id,
    type,
    state: task.state,
    message: payload.message || '',
  });
  const taskClients = clients.get(task.id) || new Set();
  for (const res of taskClients) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function setTaskState(task, state, message, extra = {}) {
  task.state = state;
  task.updatedAt = new Date().toISOString();
  if (message) task.message = message;
  Object.assign(task, extra);
  publish(task, 'state', { state, message, questions: task.questions || [], task: publicTask(task) });
}

function publicTask(task) {
  return {
    id: task.id,
    filename: task.filename,
    fileHash: task.fileHash || '',
    requirement: task.requirement,
    temporaryRules: task.temporaryRules,
    previewRows: task.previewRows,
    metadata: task.metadata,
    retrievedRules: task.retrievedRules,
    clarifications: task.clarifications,
    generatedCode: task.generatedCode,
    state: task.state,
    message: task.message,
    outputReady: Boolean(task.outputPath && fs.existsSync(task.outputPath)),
    executionWarning: task.executionWarning || '',
    indexStatus: task.indexStatus || 'pending',
    workbookProfile: task.workbookProfile || null,
    indexReused: Boolean(task.indexReused),
    agentPlan: task.agentPlan || null,
    validationReport: task.validationReport || null,
    agentTrace: task.agentTrace || [],
    agentExplorationSummary: task.agentExplorationSummary || '',
    questions: task.questions || [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function cancelledError(message = '任务已手动停止') {
  const error = new Error(message);
  error.code = 'TASK_CANCELLED';
  return error;
}

function isCancelledError(error) {
  return error?.code === 'TASK_CANCELLED' || /任务已手动停止|This operation was aborted/i.test(error?.message || '');
}

function assertTaskNotCancelled(task) {
  if (task?.cancelRequested || task?.state === 'cancelled') {
    throw cancelledError();
  }
}

function trackChildProcess(task, child, label) {
  if (!task.children) task.children = new Set();
  child.taskProcessLabel = label;
  task.children.add(child);
  const untrack = () => task.children?.delete(child);
  child.once('close', untrack);
  child.once('error', untrack);
  if (task.cancelRequested) {
    child.kill('SIGKILL');
  }
  return child;
}

function cancelTask(task, message = '已手动停止') {
  if (!task) return false;
  if (task.state === 'cancelled') return true;
  if (task.state === 'completed' || task.state === 'failed') return true;
  if (!ACTIVE_STATES.has(task.state) && task.state !== 'needs_clarification') return false;
  task.cancelRequested = true;
  if (task.abortController) {
    try {
      task.abortController.abort();
    } catch (error) {
      log('warn', 'task_abort_controller_failed', { taskId: task.id, error: error.message });
    }
  }
  for (const child of task.children || []) {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      log('warn', 'task_child_kill_failed', { taskId: task.id, label: child.taskProcessLabel || '', error: error.message });
    }
  }
  setTaskState(task, 'cancelled', message);
  log('info', 'task_cancelled', { taskId: task.id });
  return true;
}

function summarizeToolArgs(args) {
  return {
    sheetName: args.sheetName || '',
    query: args.query || '',
    column: args.column || '',
    groupBy: args.groupBy || '',
    operation: args.operation || '',
    mode: args.mode || '',
    count: args.count || undefined,
    maxResults: args.maxResults || undefined,
    startRow: args.startRow || undefined,
    endRow: args.endRow || undefined,
  };
}

function summarizeToolResult(result) {
  const data = result && result.data ? result.data : result;
  if (!data) return {};
  if (Array.isArray(data.sheets)) {
    return {
      fileKind: data.fileKind,
      sheetNames: data.sheetNames || [],
      sheets: data.sheets.map((sheet) => ({
        sheetName: sheet.sheetName,
        totalRows: sheet.totalRows,
        totalColumns: sheet.totalColumns,
        previewRows: Array.isArray(sheet.rawRows) ? sheet.rawRows.length : 0,
        mergedCells: Array.isArray(sheet.mergedCells) ? sheet.mergedCells.length : 0,
      })),
    };
  }
  if (Array.isArray(data.columns)) {
    return {
      sheetName: data.sheetName,
      totalRows: data.totalRows,
      totalColumns: data.totalColumns,
      detectedHeaderRowNumber: data.detectedHeaderRowNumber,
      columns: data.columns.slice(0, 30),
    };
  }
  if (Array.isArray(data.results)) {
    return {
      query: data.query,
      resultCount: data.resultCount,
      sample: data.results.slice(0, 5),
    };
  }
  if (Array.isArray(data.rows)) {
    return {
      sheetName: data.sheetName,
      startRow: data.startRow,
      endRow: data.endRow,
      rowCount: data.rows.length,
      matchedRows: data.matchedRows,
      sample: data.rows.slice(0, 3),
    };
  }
  if (Array.isArray(data.topValues)) {
    return {
      sheetName: data.sheetName,
      column: data.column,
      totalRows: data.totalRows,
      nonEmptyRows: data.nonEmptyRows,
      distinctCount: data.distinctCount,
      numericCount: data.numericCount,
      numericMin: data.numericMin,
      numericMax: data.numericMax,
      topValues: data.topValues.slice(0, 10),
    };
  }
  return data;
}

function compactText(value, limit = 120) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function compactRow(row, maxCells = 40) {
  const values = Array.isArray(row.values) ? row.values : [];
  return {
    rowNumber: row.rowNumber,
    values: values.slice(0, maxCells).map((value) => compactText(value, 80)),
    omittedCells: Math.max(0, values.length - maxCells),
  };
}

function compactColumn(column) {
  return {
    index: column.index,
    storageName: column.storageName,
    name: compactText(column.name, 80),
    type: column.type,
  };
}

function compactToolContentForModel(result, toolName) {
  const data = result && result.data ? result.data : result;
  if (!data) return {};
  if (data.ok === false || data.skipped) return data;
  if (Array.isArray(data.sheets)) {
    return {
      toolName,
      sheetNames: data.sheetNames || [],
      sheets: data.sheets.map((sheet) => ({
        sheetName: sheet.sheetName,
        totalRows: sheet.totalRows,
        totalColumns: sheet.totalColumns,
        detectedHeaderRowNumber: sheet.detectedHeaderRowNumber,
      })),
    };
  }
  if (Array.isArray(data.columns)) {
    return {
      toolName,
      sheetName: data.sheetName,
      totalRows: data.totalRows,
      totalColumns: data.totalColumns,
      detectedHeaderRowNumber: data.detectedHeaderRowNumber,
      columns: data.columns.slice(0, 40).map(compactColumn),
      omittedColumns: Math.max(0, data.columns.length - 40),
      rawRows: (data.rawRows || []).slice(0, 6).map((row) => compactRow(row, 24)),
    };
  }
  if (Array.isArray(data.results)) {
    return {
      toolName,
      query: data.query,
      resultCount: data.resultCount,
      results: data.results.slice(0, 10).map((item) => ({
        sheetName: item.sheetName,
        rowNumber: item.rowNumber,
        columnNumber: item.columnNumber,
        columnName: compactText(item.columnName, 80),
        value: compactText(item.value, 120),
      })),
      omittedResults: Math.max(0, data.results.length - 10),
    };
  }
  if (Array.isArray(data.rows)) {
    const rowPayload = data.rows.some((row) => Array.isArray(row.values) || row.rowNumber !== undefined);
    if (!rowPayload) {
      return {
        toolName,
        sheetName: data.sheetName,
        operation: data.operation,
        column: data.column,
        groupBy: data.groupBy,
        rowCount: data.rows.length,
        rows: data.rows.slice(0, 50),
        omittedRows: Math.max(0, data.rows.length - 50),
      };
    }
    return {
      toolName,
      sheetName: data.sheetName,
      startRow: data.startRow,
      endRow: data.endRow,
      rowCount: data.rows.length,
      matchedRows: data.matchedRows,
      rows: data.rows.slice(0, 5).map((row) => compactRow(row, 40)),
      omittedRows: Math.max(0, data.rows.length - 5),
    };
  }
  if (Array.isArray(data.topValues)) {
    return {
      toolName,
      sheetName: data.sheetName,
      column: data.column,
      totalRows: data.totalRows,
      nonEmptyRows: data.nonEmptyRows,
      distinctCount: data.distinctCount,
      numericCount: data.numericCount,
      numericMin: data.numericMin,
      numericMax: data.numericMax,
      topValues: data.topValues.slice(0, 15).map((item) => ({
        value: compactText(item.value, 120),
        count: item.count,
      })),
    };
  }
  return summarizeToolResult(data);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function normalizeToolArgs(toolName, args = {}) {
  const sheetName = args.sheetName ? String(args.sheetName).trim() : '';
  if (toolName === 'excel_list_sheets') return {};
  if (toolName === 'excel_get_schema') return sheetName ? { sheetName } : {};
  if (toolName === 'excel_read_rows') {
    return {
      sheetName,
      startRow: normalizedNumber(args.startRow),
      endRow: normalizedNumber(args.endRow),
    };
  }
  if (toolName === 'excel_sample_rows') {
    return {
      sheetName,
      mode: args.mode || 'first',
      rowNumber: args.rowNumber === undefined ? undefined : normalizedNumber(args.rowNumber),
      count: args.count === undefined ? undefined : normalizedNumber(args.count),
    };
  }
  if (toolName === 'excel_search') {
    return {
      sheetName,
      query: compactText(args.query || '', 200),
      maxResults: args.maxResults === undefined ? undefined : normalizedNumber(args.maxResults),
    };
  }
  if (toolName === 'excel_filter_rows') {
    return {
      sheetName,
      column: args.column ? String(args.column).trim() : '',
      operator: args.operator || 'contains',
      value: args.value === undefined ? undefined : compactText(args.value, 200),
      maxResults: args.maxResults === undefined ? undefined : normalizedNumber(args.maxResults),
    };
  }
  if (toolName === 'excel_aggregate') {
    return {
      sheetName,
      column: args.column ? String(args.column).trim() : '',
      operation: args.operation || 'sum',
      groupBy: args.groupBy ? String(args.groupBy).trim() : '',
    };
  }
  if (toolName === 'excel_profile_column') {
    return {
      sheetName,
      column: args.column ? String(args.column).trim() : '',
    };
  }
  return args || {};
}

function toolCacheKey(toolName, args) {
  return `${toolName}:${stableStringify(normalizeToolArgs(toolName, args))}`;
}

function findCachedToolResult(toolCache, toolName, args) {
  const exact = toolCache.get(toolCacheKey(toolName, args));
  if (exact) return { ...exact, cacheKind: 'exact' };
  if (toolName !== 'excel_read_rows') return null;
  const normalized = normalizeToolArgs(toolName, args);
  const startRow = Number(normalized.startRow);
  const endRow = Number(normalized.endRow);
  if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return null;
  for (const entry of toolCache.values()) {
    if (entry.toolName !== 'excel_read_rows') continue;
    const cachedArgs = entry.normalizedArgs || {};
    if ((cachedArgs.sheetName || '') !== (normalized.sheetName || '')) continue;
    if (Number(cachedArgs.startRow) <= startRow && Number(cachedArgs.endRow) >= endRow) {
      return { ...entry, cacheKind: 'covered_range' };
    }
  }
  return null;
}

function toolPriority(toolName, args = {}) {
  if (toolName === 'excel_list_sheets') return 100;
  if (toolName === 'excel_get_schema') return 90;
  if (toolName === 'excel_aggregate' || toolName === 'excel_profile_column') return 80;
  if (toolName === 'excel_search' || toolName === 'excel_filter_rows') return 70;
  if (toolName === 'excel_read_rows') return 50;
  if (toolName === 'excel_sample_rows' && args.mode === 'random') return 10;
  if (toolName === 'excel_sample_rows') return 40;
  return 0;
}

function budgetSkippedToolContent(toolName, reason, remainingBudget) {
  return {
    ok: false,
    skipped: true,
    toolName,
    reason,
    remainingToolBudget: Math.max(0, remainingBudget),
    guidance: remainingBudget <= 0
      ? '工具总预算已耗尽。请立即基于已有证据输出规定 JSON，不要继续请求工具。'
      : '本轮只执行最高价值工具。请基于已有证据判断，下一轮如必须调用工具，只请求一个最关键工具。',
  };
}

function summarizeModelMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    contentChars: typeof message.content === 'string' ? message.content.length : 0,
    reasoningChars: typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0,
    toolCallId: message.tool_call_id,
    toolCalls: (message.tool_calls || []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name,
      argumentChars: toolCall.function?.arguments?.length || 0,
    })),
  }));
}

function summarizeModelRequest(requestBody) {
  return {
    model: requestBody.model,
    temperature: requestBody.temperature,
    stream: requestBody.stream,
    toolCount: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
    toolChoice: requestBody.tool_choice || '',
    messages: summarizeModelMessages(requestBody.messages || []),
  };
}

function shouldPassReasoningContent(model) {
  return /deepseek/i.test(model || '');
}

function toAssistantHistoryMessage(message, model) {
  const historyMessage = {
    role: 'assistant',
    content: message.content || '',
  };
  if (shouldPassReasoningContent(model) && message.reasoning_content) {
    historyMessage.reasoning_content = message.reasoning_content;
  }
  if (message.tool_calls) {
    historyMessage.tool_calls = message.tool_calls;
  }
  return historyMessage;
}

function requiresAccountingClarification(requirement) {
  const text = String(requirement || '');
  const asksTableIdentity = /是什么表|什么表|有什么用|用途|表格用途|结构概览|整体概览|识别.*表/i.test(text);
  const asksStructuredCalculation = /计算|统计|求和|汇总|合计|总计|金额|收入|支出|借方|贷方|交易|流水|账|账单|往来|应收|应付|日期|时间|按月|按日|分类|筛选|多少|占比|比例/i.test(text);
  return asksStructuredCalculation && !asksTableIdentity;
}

function needsClarification(task) {
  if (!requiresAccountingClarification(task.requirement)) return [];
  const headers = [
    ...task.metadata.columns.map((column) => column.name),
    ...(task.metadata.rawRows || []).flatMap((row) => row.values || []),
  ].join(' ');
  const hasAmount = /金额|借方|贷方|收入|支出|amount|debit|credit/i.test(headers);
  const hasDate = /日期|时间|date|time/i.test(headers);
  const questions = [];
  if (!hasAmount) questions.push('未识别到明确的金额列，请指定哪一列代表本次计算的金额。');
  if (!hasDate) questions.push('未识别到明确的日期列，请指定哪一列代表交易日期。');
  if (/其他应收|应收|往来/.test(headers)) {
    questions.push('表头包含应收或往来字段，请确认是否包含员工借款、押金等需要单独分类的业务。');
  }
  return questions;
}

function isSuspiciousGeneratedCode(code) {
  const patterns = [
    /(?:^|\n)\s*INPUT_FILE\s*=/,
    /(?:^|\n)\s*OUTPUT_FILE\s*=/,
    /import\s+os\b/,
    /import\s+sys\b/,
    /import\s+pathlib\b/,
    /import\s+subprocess\b/,
    /import\s+requests\b/,
    /from\s+(?:os|sys|pathlib|subprocess|requests)\b/,
    /\bglobals\s*\(/,
    /\blocals\s*\(/,
    /\bopen\s*\(/,
    /Alice|Bob|Charlie|dummy|示例文件|example input/i,
  ];
  return patterns.some((pattern) => pattern.test(code));
}

function validateGeneratedCodeContract(code) {
  const failures = [];
  if (!/^\s*(import\s+pandas\s+as\s+pd|from\s+pandas\s+import\s+)/m.test(code)) {
    failures.push('必须 import pandas as pd');
  }
  if (/(?:^|\n)\s*INPUT_FILE\s*=/.test(code)) {
    failures.push('禁止给 INPUT_FILE 重新赋值');
  }
  if (/(?:^|\n)\s*OUTPUT_FILE\s*=/.test(code)) {
    failures.push('禁止给 OUTPUT_FILE 重新赋值');
  }
  if (/\b(?:os|sys|pathlib|subprocess|requests|socket|urllib|http|shutil|ctypes)\b/.test(code)) {
    failures.push('禁止导入或使用沙盒禁用模块');
  }
  if (/\b(?:globals|locals|open|eval|exec|compile|__import__)\s*\(/.test(code)) {
    failures.push('禁止调用沙盒禁用函数');
  }
  if (/Alice|Bob|Charlie|dummy|示例文件|example input/i.test(code)) {
    failures.push('禁止生成示例数据或示例文件');
  }
  if (!/OUTPUT_FILE/.test(code)) {
    failures.push('必须写入 OUTPUT_FILE');
  }
  if (failures.length) {
    throw new Error(`生成代码未满足执行合同：${failures.join('；')}`);
  }
}

async function callOpenAiCompatible(messages, temperature = 0.1, context = {}, options = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const ownerTask = context.taskId ? tasks.get(context.taskId) : null;
  assertTaskNotCancelled(ownerTask);
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const startedAt = Date.now();
  const stream = options.stream !== undefined ? Boolean(options.stream) : true;
  const requestBody = { model, messages, temperature, stream };
  if (options.tools) requestBody.tools = options.tools;
  if (options.toolChoice) requestBody.tool_choice = options.toolChoice;
  const controller = new AbortController();
  if (ownerTask) ownerTask.abortController = controller;
  log('info', stream ? 'model_stream_request_started' : 'model_request_started', { ...context, model, baseUrl });
  log('info', 'model_request_body', { ...context, requestBody: summarizeModelRequest(requestBody) });
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (ownerTask?.abortController === controller) ownerTask.abortController = null;
    if (ownerTask?.cancelRequested || error.name === 'AbortError') throw cancelledError();
    throw error;
  }
  assertTaskNotCancelled(ownerTask);
  if (!response.ok) {
    const detail = await response.text();
    log('error', stream ? 'model_stream_request_failed' : 'model_request_failed', { ...context, status: response.status, detail: detail.slice(0, 500), responseBody: detail });
    if (ownerTask?.abortController === controller) ownerTask.abortController = null;
    throw new Error(`模型调用失败 ${response.status}: ${detail.slice(0, 500)}`);
  }

  if (!stream) {
    const data = await response.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    log('info', 'model_completed', {
      ...context,
      model,
      durationMs: Date.now() - startedAt,
      chars: message?.content ? message.content.length : 0,
      reasoningChars: message?.reasoning_content ? message.reasoning_content.length : 0,
      toolCalls: (message?.tool_calls || []).map((toolCall) => toolCall.function?.name).filter(Boolean),
      responseBody: {
        id: data.id,
        object: data.object,
        usage: data.usage,
        choices: (data.choices || []).map((choice) => ({
          index: choice.index,
          finish_reason: choice.finish_reason,
          message: {
            role: choice.message?.role,
            contentChars: choice.message?.content ? choice.message.content.length : 0,
            reasoningChars: choice.message?.reasoning_content ? choice.message.reasoning_content.length : 0,
            toolCalls: (choice.message?.tool_calls || []).map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.function?.name,
              argumentChars: toolCall.function?.arguments?.length || 0,
            })),
          },
        })),
      },
    });
    if (ownerTask?.abortController === controller) ownerTask.abortController = null;
    return options.returnMessage ? message : (message?.content || '');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    const data = await response.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    log('info', 'model_non_stream_completed', {
      ...context,
      model,
      durationMs: Date.now() - startedAt,
      chars: content ? content.length : 0,
      responseBody: {
        id: data.id,
        object: data.object,
        usage: data.usage,
        contentChars: content ? content.length : 0,
      },
    });
    if (ownerTask?.abortController === controller) ownerTask.abortController = null;
    return content;
  }

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let buffer = '';
  let content = '';
  let reasoningChars = 0;
  let sawFirstChunk = false;

  const consumeSseData = (rawData) => {
    if (!rawData || rawData === '[DONE]') return;
    try {
      const payload = JSON.parse(rawData);
      const delta = payload.choices && payload.choices[0] && payload.choices[0].delta;
      const reasoningText = delta && delta.reasoning_content ? delta.reasoning_content : '';
      const text = delta && delta.content ? delta.content : '';
      reasoningChars += reasoningText.length;
      if (text) {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          log('info', 'model_stream_first_chunk', {
            ...context,
            model,
            latencyMs: Date.now() - startedAt,
          });
        }
        content += text;
      }
    } catch (error) {
      log('warn', 'model_stream_chunk_parse_failed', { ...context, error: error.message, chunk: rawData.slice(0, 200) });
    }
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (ownerTask?.abortController === controller) ownerTask.abortController = null;
      if (ownerTask?.cancelRequested || error.name === 'AbortError') throw cancelledError();
      throw error;
    }
    const { value, done } = chunk;
    if (done) break;
    assertTaskNotCancelled(ownerTask);
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          consumeSseData(line.slice(5).trim());
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        consumeSseData(line.slice(5).trim());
      }
    }
  }

  log('info', 'model_stream_completed', {
    ...context,
    model,
    durationMs: Date.now() - startedAt,
    chars: content.length,
    reasoningChars,
    responseBody: `[model content ${content.length} chars]`,
  });
  if (ownerTask?.abortController === controller) ownerTask.abortController = null;
  return content;
}

function extractCodeBlock(text) {
  if (!text) return '';
  const match = /```(?:python)?\s*([\s\S]*?)```/i.exec(text);
  return match ? match[1].trim() : '';
}

const EXCEL_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'excel_list_sheets',
      description: '列出当前工作簿的工作表、行数、列数和表头候选。先调用这个工具了解全局结构。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_get_schema',
      description: '读取指定工作表的列结构、表头候选和前 20 行样本。用于确认列名、列号和表头行。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: {
            type: 'string',
            description: '可选。指定工作表名称；省略时使用默认工作表。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_read_rows',
      description: '读取当前任务表格中指定工作表的连续行。行号为 Excel 语义的 1-based 闭区间，单次最多 200 行。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: {
            type: 'string',
            description: '可选。指定工作表名称；省略时读取默认工作表。CSV 文件忽略该字段。',
          },
          startRow: {
            type: 'integer',
            minimum: 1,
            description: '起始行号，1-based，包含该行。',
          },
          endRow: {
            type: 'integer',
            minimum: 1,
            description: '结束行号，1-based，包含该行。',
          },
        },
        required: ['startRow', 'endRow'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_sample_rows',
      description: '读取指定工作表的样本行，支持 first、last、around、random。用于快速观察大表局部结构。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: '可选。工作表名称。' },
          mode: { type: 'string', enum: ['first', 'last', 'around', 'random'], description: '采样方式，默认 first。' },
          rowNumber: { type: 'integer', minimum: 1, description: 'mode=around 时的中心行号。' },
          count: { type: 'integer', minimum: 1, maximum: 200, description: '最多读取多少行，默认 20。' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_search',
      description: '在索引中做大小写不敏感的文本包含搜索，返回 sheet、1-based 行号、列号、列名和值。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文本关键词，不能为空。' },
          sheetName: { type: 'string', description: '可选。指定工作表；省略时搜索整个工作簿。' },
          maxResults: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条命中，默认 20，最大 50。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_filter_rows',
      description: '按列过滤行，适合定位大表中的候选记录。column 可用列名、列号或 c1/c2。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: '可选。工作表名称。' },
          column: { type: 'string', description: '列名、1-based 列号或 cN。' },
          operator: { type: 'string', enum: ['contains', 'equals', 'not_empty', 'gt', 'gte', 'lt', 'lte'], description: '过滤操作，默认 contains。' },
          value: { type: 'string', description: '过滤值；not_empty 可省略。' },
          maxResults: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少行，默认 50。' },
        },
        required: ['column'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_aggregate',
      description: '对指定列做 sum/avg/min/max/count，可选按另一列分组。适合先验证金额、数量、分类汇总。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: '可选。工作表名称。' },
          column: { type: 'string', description: '要聚合的列名、列号或 cN。' },
          operation: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'], description: '聚合操作，默认 sum。' },
          groupBy: { type: 'string', description: '可选。分组列名、列号或 cN。' },
        },
        required: ['column'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_profile_column',
      description: '查看指定列的非空数量、去重数量、数值范围和高频值，帮助判断列语义。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: '可选。工作表名称。' },
          column: { type: 'string', description: '列名、1-based 列号或 cN。' },
        },
        required: ['column'],
        additionalProperties: false,
      },
    },
  },
];

function parseToolArguments(rawArguments) {
  if (!rawArguments) return {};
  try {
    return JSON.parse(rawArguments);
  } catch (error) {
    throw new Error(`工具参数不是合法 JSON: ${error.message}`);
  }
}

function isFatalExcelToolError(error) {
  const message = error?.message || String(error || '');
  return /Unable to create process|spawn .*ENOENT|duckdb 不可用|openpyxl 不可用|Excel 工具输出无法解析|索引不存在/i.test(message);
}

function toolErrorData(error, toolName) {
  const message = error?.message || String(error || '工具调用失败');
  return {
    ok: false,
    toolName,
    error: message,
    guidance: '这是一次可恢复的工具错误。请根据错误信息调整参数后继续调用工具，例如缩小读取行范围、改用搜索定位行号，或指定正确的工作表名称。',
  };
}

function parseDsmlToolCalls(content) {
  if (!content || !content.includes('DSML') || !content.includes('invoke')) return [];
  const calls = [];
  const invokePattern = /<[^>]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*invoke>/g;
  let invokeMatch;
  while ((invokeMatch = invokePattern.exec(content)) !== null) {
    const args = {};
    const paramPattern = /<[^>]*parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?[^>]*>([\s\S]*?)<\/[^>]*parameter>/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(invokeMatch[2])) !== null) {
      const rawValue = paramMatch[3].trim();
      if (paramMatch[2] === 'false' && /^-?\d+(\.\d+)?$/.test(rawValue)) {
        args[paramMatch[1]] = Number(rawValue);
      } else {
        args[paramMatch[1]] = rawValue;
      }
    }
    calls.push({
      id: `dsml_${crypto.randomUUID()}`,
      type: 'function',
      function: {
        name: invokeMatch[1],
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

function extractJsonObject(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function buildWorkbookIndex(task) {
  return new Promise((resolve, reject) => {
    try {
      assertTaskNotCancelled(task);
    } catch (error) {
      reject(error);
      return;
    }
    const python = process.env.PYTHON_BIN || 'python';
    const script = path.join(__dirname, 'excel_tools.py');
    const indexDir = task.indexDir || path.join(task.dir, 'index');
    fs.mkdirSync(indexDir, { recursive: true });
    const child = spawn(python, [script, 'build-index', task.filePath, indexDir], {
      cwd: task.dir,
      windowsHide: true,
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    trackChildProcess(task, child, 'build-index');
    let stdout = '';
    let lineBuffer = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, WORKBOOK_INDEX_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (task.cancelRequested) {
        child.kill('SIGKILL');
        return;
      }
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'index_progress') {
            const total = Number(event.totalRows || 0);
            const done = Number(event.indexedRows || 0);
            const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
            publish(task, 'index_progress', {
              message: total > 0
                ? `正在索引 ${event.sheetName || ''}：${done}/${total} 行（${percent}%）`
                : `正在索引 ${event.sheetName || ''}：已处理 ${done} 行`,
              sheetName: event.sheetName || '',
              indexedRows: done,
              totalRows: total || null,
              percent,
              phase: event.phase || '',
              task: publicTask(task),
            });
          }
        } catch (error) {
          // Final result is also JSON; it is parsed when the child closes.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (task.cancelRequested) {
        reject(cancelledError());
        return;
      }
      if (timedOut) {
        reject(new Error(`索引构建超时：超过 ${Math.round(WORKBOOK_INDEX_TIMEOUT_MS / 1000)} 秒。请增大 WORKBOOK_INDEX_TIMEOUT_MS，或先拆分超大 Excel 文件。`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
      } catch (error) {
        reject(new Error(`索引构建输出无法解析: ${(stderr || stdout || error.message).slice(0, 500)}`));
        return;
      }
      if (code !== 0 || !parsed.ok) {
        reject(new Error(parsed.error || stderr || `索引构建失败，退出码 ${code}`));
        return;
      }
      resolve({ indexDir, manifest: parsed.data });
    });
  });
}

function runExcelTool(task, toolName, args) {
  return new Promise((resolve, reject) => {
    try {
      assertTaskNotCancelled(task);
    } catch (error) {
      reject(error);
      return;
    }
    const allowedTools = new Set(EXCEL_AGENT_TOOLS.map((tool) => tool.function.name));
    if (!allowedTools.has(toolName)) {
      reject(new Error(`未知工具: ${toolName}`));
      return;
    }
    const resolvedIndex = path.resolve(task.indexDir || path.join(task.dir, 'index'));
    if (!isPathInside(TASK_DIR, resolvedIndex)) {
      reject(new Error('工具只能读取任务缓存目录内的索引'));
      return;
    }
    const python = process.env.PYTHON_BIN || 'python';
    const script = path.join(__dirname, 'excel_tools.py');
    const child = spawn(python, [script, 'tool', resolvedIndex, toolName, JSON.stringify(args || {})], {
      cwd: task.dir,
      windowsHide: true,
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    trackChildProcess(task, child, `excel-tool:${toolName}`);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), EXCEL_TOOL_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (task.cancelRequested) {
        reject(cancelledError());
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
      } catch (error) {
        reject(new Error(`Excel 工具输出无法解析: ${(stderr || stdout || error.message).slice(0, 500)}`));
        return;
      }
      if (code !== 0 || !parsed.ok) {
        reject(new Error(parsed.error || stderr || `Excel 工具失败，退出码 ${code}`));
        return;
      }
      resolve(parsed);
    });
  });
}

function applyAgentPlan(task, plan) {
  task.agentPlan = plan;
  task.agentExplorationSummary = plan.implementation_plan || JSON.stringify(plan);
  publish(task, 'agent_summary', {
    message: task.agentExplorationSummary || '数据探索完成',
    plan,
    task: publicTask(task),
  });
  if (plan.status === 'needs_clarification' && Array.isArray(plan.questions) && plan.questions.length) {
    task.questions = plan.questions;
  }
  return task.agentExplorationSummary;
}

async function requestFinalExplorationJson(task, messages, model, round, reason) {
  messages.push({
    role: 'user',
    content: [
      reason,
      `当前 Excel 工具预算上限为 ${AGENT_TOOL_CALL_LIMIT} 次，已进入收敛阶段。`,
      '现在禁止继续调用工具。请只基于已有工具结果输出规定 JSON 对象，不要输出 Markdown，不要生成代码。',
    ].join('\n'),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const message = await callOpenAiCompatible(messages, 0, {
      taskId: task.id,
      phase: 'explore_data_final',
      round,
      attempt,
    }, {
      stream: false,
      returnMessage: true,
    });
    if (!message) throw new Error('模型未返回工具探索总结');
    const plan = extractJsonObject(message.content || '');
    if (plan && plan.status && Array.isArray(plan.evidence)) {
      return applyAgentPlan(task, plan);
    }
    messages.push(toAssistantHistoryMessage(message, model));
    messages.push({
      role: 'user',
      content: '上一次回复不是合法 JSON，或缺少 status/evidence。不要调用工具，只输出规定 JSON 对象。',
    });
  }
  throw new Error('模型未能在工具预算内输出合法探索 JSON');
}

async function exploreDataWithTools(task) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('缺少 OPENAI_API_KEY，无法执行模型工具调用探索');
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  task.agentTrace = [];
  const toolCache = new Map();
  const systemPrompt = [
    '你是一个 Excel 数据探索 Agent。',
    '你必须通过提供的索引工具按需查询当前上传表格，不能假设没有查询过的数据。',
    '工具行号均为 Excel 语义的 1-based 行号；列可以用列名、列号或 c1/c2。',
    `工具总预算最多 ${AGENT_TOOL_CALL_LIMIT} 次；每轮最多请求 ${AGENT_TOOL_CALLS_PER_ROUND} 个工具。`,
    '先调用 excel_list_sheets 判断相关工作表，只对最相关工作表调用 excel_get_schema，不要一次性扫描所有 sheet schema。',
    '用 search/filter/aggregate/profile 定位证据；只有需要确认表头或样本时才读取少量行。',
    '不要请求读取整个文件；需要大范围分析时使用 filter、aggregate 或 profile。',
    '不要重复请求相同工具参数；不要用 random 采样代替明确证据。',
    '当剩余预算不足或信息足够时，立即停止调用工具，并只输出规定 JSON 对象。',
    '当信息足够时，停止调用工具，并只输出一个 JSON 对象，不要输出 Markdown。',
    'JSON 格式：{"status":"ready|needs_clarification","confidence":0-1,"evidence":[{"tool":"工具名","finding":"发现","rows":[行号]}],"needed_columns":["列名"],"implementation_plan":"后续代码生成依据","questions":["需要用户补充的问题"]}',
  ].join('\n');
  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        '请探索当前上传的 Excel/CSV 文件，为后续生成 pandas 处理脚本收集必要证据。',
        '',
        '【用户需求】',
        task.requirement,
        '',
        '【本次特例规则】',
        task.temporaryRules || '无',
        '',
        '【初始元数据】',
        JSON.stringify(task.metadata),
        '',
        '【召回规则】',
        JSON.stringify(task.retrievedRules || []),
        '',
        '探索完成后不要生成代码，只输出结构化 JSON。',
      ].join('\n'),
    },
  ];

  let toolCallCount = 0;
  for (let round = 0; round <= AGENT_TOOL_CALL_LIMIT; round += 1) {
    assertTaskNotCancelled(task);
    if (toolCallCount >= AGENT_TOOL_CALL_LIMIT - AGENT_FORCE_FINAL_REMAINING) {
      return requestFinalExplorationJson(task, messages, model, round, '工具预算即将耗尽。');
    }
    const message = await callOpenAiCompatible(messages, 0, {
      taskId: task.id,
      phase: 'explore_data',
      round,
    }, {
      stream: false,
      tools: EXCEL_AGENT_TOOLS,
      toolChoice: 'auto',
      returnMessage: true,
    });
    if (!message) throw new Error('模型未返回工具探索消息');
    let toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      toolCalls = parseDsmlToolCalls(message.content || '');
      if (toolCalls.length) {
        message.tool_calls = toolCalls;
        message.content = '';
      }
    }
    if (!toolCalls.length) {
      if (toolCallCount === 0) {
        throw new Error('模型未调用任何 Excel 工具；请确认当前模型和中转服务支持原生 tools/tool_calls，请再次运行重试。');
      }
      const plan = extractJsonObject(message.content || '');
      if (!plan || !plan.status || !Array.isArray(plan.evidence)) {
        messages.push(toAssistantHistoryMessage(message, model));
        messages.push({
          role: 'user',
          content: '你的探索结论不是合法 JSON，或缺少 status/evidence。请继续必要的工具调用；如果已经足够，请只输出规定 JSON 对象。',
        });
        continue;
      }
      return applyAgentPlan(task, plan);
    }

    messages.push(toAssistantHistoryMessage(message, model));

    const parsedToolCalls = toolCalls.map((toolCall, index) => {
      let args = {};
      let argumentError = null;
      try {
        args = parseToolArguments(toolCall.function?.arguments || '{}');
      } catch (error) {
        argumentError = error;
      }
      const toolName = toolCall.function?.name || '';
      const cacheHit = argumentError ? null : findCachedToolResult(toolCache, toolName, args);
      return { toolCall, index, toolName, args, argumentError, cacheHit };
    });
    const remainingBeforeRound = AGENT_TOOL_CALL_LIMIT - toolCallCount;
    const selectedIndexes = new Set(
      parsedToolCalls
        .filter((item) => !item.argumentError && !item.cacheHit)
        .sort((left, right) => {
          const priorityDelta = toolPriority(right.toolName, right.args) - toolPriority(left.toolName, left.args);
          return priorityDelta || left.index - right.index;
        })
        .slice(0, Math.max(0, Math.min(remainingBeforeRound, AGENT_TOOL_CALLS_PER_ROUND)))
        .map((item) => item.index),
    );

    for (const item of parsedToolCalls) {
      assertTaskNotCancelled(task);
      const { toolCall, toolName, args, argumentError, cacheHit } = item;
      const traceItem = {
        toolName,
        args: argumentError ? { invalidArguments: true } : summarizeToolArgs(args),
        at: new Date().toISOString(),
      };
      task.agentTrace.push(traceItem);
      publish(task, 'tool_call', {
        message: `调用 ${toolName}`,
        toolName,
        args: traceItem.args,
        task: publicTask(task),
      });

      let toolContent;
      try {
        if (argumentError) throw argumentError;
        if (cacheHit) {
          toolContent = { ...cacheHit.modelContent, cacheHit: true, cacheKind: cacheHit.cacheKind };
          traceItem.result = { ...cacheHit.resultSummary, cacheHit: cacheHit.cacheKind };
          publish(task, 'tool_result', {
            message: `${toolName} 复用缓存摘要`,
            toolName,
            result: traceItem.result,
            task: publicTask(task),
          });
        } else if (!selectedIndexes.has(item.index)) {
          const remainingBudget = AGENT_TOOL_CALL_LIMIT - toolCallCount;
          const reason = remainingBudget <= 0 ? '工具总预算已用完' : '本轮工具执行名额已用完';
          toolContent = budgetSkippedToolContent(toolName, reason, remainingBudget);
          traceItem.result = summarizeToolResult(toolContent);
          publish(task, 'tool_result', {
            message: `${toolName} 已跳过：${reason}`,
            toolName,
            result: toolContent,
            task: publicTask(task),
          });
        } else {
          toolCallCount += 1;
          const result = await runExcelTool(task, toolName, args);
          const resultSummary = summarizeToolResult(result);
          const modelContent = compactToolContentForModel(result, toolName);
          traceItem.result = resultSummary;
          publish(task, 'tool_result', {
            message: `${toolName} 已返回摘要`,
            toolName,
            result: resultSummary,
            task: publicTask(task),
          });
          toolContent = modelContent;
          toolCache.set(toolCacheKey(toolName, args), {
            toolName,
            normalizedArgs: normalizeToolArgs(toolName, args),
            resultSummary,
            modelContent,
          });
        }
      } catch (error) {
        if (isFatalExcelToolError(error)) {
          throw error;
        }
        toolContent = toolErrorData(error, toolName);
        traceItem.result = summarizeToolResult(toolContent);
        publish(task, 'tool_result', {
          message: `${toolName} 调用失败：${toolContent.error}`,
          toolName,
          result: toolContent,
          task: publicTask(task),
        });
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(toolContent),
      });
    }
    if (toolCallCount >= AGENT_TOOL_CALL_LIMIT - AGENT_FORCE_FINAL_REMAINING) {
      return requestFinalExplorationJson(task, messages, model, round + 1, '工具预算即将耗尽。');
    }
  }
  return requestFinalExplorationJson(task, messages, model, AGENT_TOOL_CALL_LIMIT + 1, '已达到探索轮次上限。');
}

async function generateCode(task) {
  const systemPrompt = [
    '你是 Python 代码生成器。',
    '你的整个回复必须只包含一个 Markdown fenced code block，格式必须是 ```python ... ```。',
    '代码块外禁止输出任何解释、分析、标题、列表或自然语言。',
    '代码块内第一段有效代码必须包含 import pandas as pd。',
    'INPUT_FILE 和 OUTPUT_FILE 是沙盒预置全局变量，只能读取使用，绝对禁止重新赋值。',
    '禁止导入或使用 os、sys、pathlib、subprocess、requests、socket、urllib、http、shutil、ctypes。',
    '禁止调用 globals、locals、open、eval、exec、compile、__import__。',
    '禁止创建示例数据、示例文件、dummy 数据，必须处理真实 INPUT_FILE。',
  ].join('\n');
  const prompt = [
    '请严格按以下执行合同生成 Python 源码，并包裹在唯一的 Markdown Python 代码块中。',
    '',
    '【执行合同】',
    '- 整个回复只能是一个 ```python 代码块，代码块外不能有任何文字。',
    '- 必须使用 INPUT_FILE 读取用户上传文件，必须使用 OUTPUT_FILE 写出结果。',
    '- 禁止出现 INPUT_FILE = ... 或 OUTPUT_FILE = ...。',
    '- 禁止导入 os/sys/pathlib/subprocess/requests/socket/urllib/http/shutil/ctypes。',
    '- 禁止调用 globals/locals/open/eval/exec/compile/__import__。',
    '- 禁止创建示例输入文件、示例 DataFrame、dummy/Alice/Bob/Charlie 数据。',
    '- 必须 import pandas as pd。',
    '- 必须把结果写入 OUTPUT_FILE，且至少一个 sheet。',
    '',
    '【任务】',
    '目标：根据用户需求，为当前上传文件生成定制化 pandas/openpyxl 处理脚本，并在本地沙盒执行。',
    '',
    '【表格读取要求】',
    '- 不要假设第一行是表头。',
    '- 必须结合 metadata.rawRows、metadata.mergedCells、metadata.detectedHeaderRowNumber 判断真实表头。',
    '- 如果 detectedHeaderRowNumber 有值，优先使用它；读取时注意 pandas header/skiprows 是 0-based。',
    '- 如果多行表头或合并单元格导致列名为空，应根据 rawRows 合成可用列名。',
    '- 如果用户指定 Sheet1，优先读取 Sheet1；否则使用 metadata.sheetName。',
    '',
    '【失败方式】',
    '- 如果缺少完成需求所需的列，raise ValueError，错误中说明缺少列和当前列名。',
    '- 不要用无关示例逻辑替代用户需求。',
    '',
    '【上下文】',
    `metadata_json = ${JSON.stringify(task.metadata)}`,
    `workbook_profile = ${JSON.stringify(task.workbookProfile || {})}`,
    `user_requirement = ${task.requirement}`,
    `temporary_rules = ${task.temporaryRules || '无'}`,
    `retrieved_rules = ${JSON.stringify(task.retrievedRules)}`,
    `clarifications = ${JSON.stringify(task.clarifications || [])}`,
    `agent_plan = ${JSON.stringify(task.agentPlan || {})}`,
    `agent_exploration_summary = ${task.agentExplorationSummary || '无'}`,
    `agent_tool_trace = ${JSON.stringify(task.agentTrace || [])}`,
  ].join('\n');
  try {
    const modelText = await callOpenAiCompatible([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], 0, { taskId: task.id, phase: 'generate_code' });
    const code = extractCodeBlock(modelText);
    if (!code || isSuspiciousGeneratedCode(code)) {
      throw new Error('模型未返回合法 Markdown Python 代码块，或返回了示例代码/硬编码输入输出路径，已拒绝执行。');
    }
    validateGeneratedCodeContract(code);
    return code;
  } catch (error) {
    publish(task, 'error', {
      message: `模型未生成可执行的定制化代码：${error.message}`,
    });
    throw error;
  }
}

async function repairCode(task, traceback) {
  const repairSystemPrompt = [
    '你是 Python 代码修复器。',
    '你的整个回复必须只包含一个 Markdown fenced code block，格式必须是 ```python ... ```。',
    '代码块外禁止输出任何解释、分析、标题、列表或自然语言。',
    '必须保留 INPUT_FILE 和 OUTPUT_FILE 为沙盒预置变量，禁止重新赋值。',
    '禁止导入或使用 os、sys、pathlib、subprocess、requests、socket、urllib、http、shutil、ctypes。',
    '禁止调用 globals、locals、open、eval、exec、compile、__import__。',
    '禁止创建示例数据或示例文件。',
  ].join('\n');
  const modelText = await callOpenAiCompatible([
    { role: 'system', content: repairSystemPrompt },
    { role: 'user', content: `请修复以下代码。整个回复只能是一个 Markdown Python 代码块。\n\n【执行合同】\n- 整个回复只能是一个 \`\`\`python 代码块，代码块外不能有任何文字。\n- 必须使用 INPUT_FILE 和 OUTPUT_FILE，禁止重新赋值。\n- 禁止硬编码 input.xlsx/output.xlsx。\n- 禁止导入 os/sys/pathlib/subprocess/requests/socket/urllib/http/shutil/ctypes。\n- 禁止调用 globals/locals/open/eval/exec/compile/__import__。\n- 禁止示例数据，必须处理真实上传文件。\n- 必须 import pandas as pd。\n\n【原代码】\n${task.generatedCode}\n\n【报错】\n${traceback}\n\n【上下文】\nmetadata_json = ${JSON.stringify(task.metadata)}\nworkbook_profile = ${JSON.stringify(task.workbookProfile || {})}\nuser_requirement = ${task.requirement}\nagent_plan = ${JSON.stringify(task.agentPlan || {})}\nagent_exploration_summary = ${task.agentExplorationSummary || '无'}\nagent_tool_trace = ${JSON.stringify(task.agentTrace || [])}` },
  ], 0, { taskId: task.id, phase: 'repair_code' });
  const code = extractCodeBlock(modelText);
  if (!code || isSuspiciousGeneratedCode(code)) {
    throw new Error('模型修复结果未返回合法 Markdown Python 代码块，或包含沙盒禁用/硬编码模式，已拒绝执行。');
  }
  validateGeneratedCodeContract(code);
  return code;
}

function writeGeneratedCode(task, code) {
  task.generatedCode = code;
  const scriptPath = path.join(task.dir, 'generated.py');
  fs.writeFileSync(scriptPath, `${code.trim()}\n`, 'utf8');
  return scriptPath;
}

function runSandbox(task) {
  return new Promise((resolve) => {
    try {
      assertTaskNotCancelled(task);
    } catch (error) {
      resolve({ ok: false, cancelled: true, error: error.message });
      return;
    }
    const python = process.env.PYTHON_BIN || 'python';
    const runner = path.join(__dirname, 'sandbox', 'runner.py');
    const script = path.join(task.dir, 'generated.py');
    const output = path.join(task.dir, 'output.xlsx');
    const timeoutSeconds = Math.max(1, Math.ceil(SANDBOX_TIMEOUT_MS / 1000));
    log('info', 'sandbox_started', {
      taskId: task.id,
      python,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      script,
      output,
    });
    const child = spawn(python, [runner, script, task.filePath, output, String(timeoutSeconds)], {
      cwd: task.dir,
      windowsHide: true,
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    trackChildProcess(task, child, 'sandbox');
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SANDBOX_TIMEOUT_MS + 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      log('error', 'sandbox_spawn_failed', { taskId: task.id, error: error.message });
      resolve({ ok: false, error: error.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (task.cancelRequested) {
        resolve({ ok: false, cancelled: true, error: '任务已手动停止' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
        log(parsed.ok ? 'info' : 'error', 'sandbox_finished', {
          taskId: task.id,
          ok: Boolean(parsed.ok),
          error: parsed.error || '',
          detail: (parsed.detail || stderr || '').slice(0, 500),
          outputExists: fs.existsSync(output),
        });
        if (parsed.ok) {
          resolve({ ok: true, output });
          return;
        }
        if (fs.existsSync(output)) {
          const warning = [parsed.error, parsed.detail || stderr].filter(Boolean).join('\n').trim();
          log('warn', 'sandbox_output_accepted_with_warning', {
            taskId: task.id,
            output,
            warning: warning.slice(0, 500),
          });
          resolve({ ok: true, output, warning });
          return;
        }
        resolve({ ok: false, error: parsed.error, detail: parsed.detail || stderr });
      } catch (error) {
        if (fs.existsSync(output)) {
          const warning = (stderr || stdout || error.message || '沙盒输出解析失败').trim();
          log('warn', 'sandbox_unparseable_output_accepted', {
            taskId: task.id,
            output,
            warning: warning.slice(0, 500),
          });
          resolve({ ok: true, output, warning });
          return;
        }
        log('error', 'sandbox_parse_failed', {
          taskId: task.id,
          error: error.message,
          stdout: stdout.slice(0, 500),
          stderr: stderr.slice(0, 500),
        });
        resolve({ ok: false, error: stderr || stdout || error.message });
      }
    });
  });
}

async function validateOutput(task, outputPath) {
  const report = {
    ok: false,
    outputExists: Boolean(outputPath && fs.existsSync(outputPath)),
    sheets: [],
    warnings: [],
  };
  if (!report.outputExists) {
    report.warnings.push('输出文件不存在');
    return report;
  }
  try {
    const metadata = await extractMetadata(outputPath, 'output.xlsx', 10);
    report.ok = true;
    report.sheets = (metadata.sheetNames || [metadata.sheetName]).filter(Boolean);
    report.totalRows = metadata.totalRows;
    report.totalColumns = metadata.totalColumns;
    if (!report.sheets.length) report.warnings.push('输出文件没有工作表');
    if (!metadata.totalRows) report.warnings.push('默认工作表没有数据行');
  } catch (error) {
    report.warnings.push(`输出文件校验失败: ${error.message}`);
  }
  return report;
}

async function executeWorkflow(task) {
  try {
    assertTaskNotCancelled(task);
    log('info', 'workflow_started', { taskId: task.id, filename: task.filename });
    if (task.indexStatus !== 'ready') {
      const manifestPath = path.join(task.indexDir || path.join(task.dir, 'index'), 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        task.workbookProfile = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        touchIfExists(task.fileCacheDir);
        touchIfExists(task.indexDir);
        touchIfExists(manifestPath);
        task.indexReused = true;
        task.indexStatus = 'ready';
        publish(task, 'index_ready', {
          message: '复用已有 DuckDB 表格索引',
          profile: summarizeToolResult({ sheets: task.workbookProfile.sheets || [] }),
          task: publicTask(task),
        });
      } else {
        task.indexStatus = 'indexing';
        setTaskState(task, 'indexing', '正在构建大型表格索引');
        publish(task, 'indexing', { message: '正在构建 DuckDB 表格索引', task: publicTask(task) });
        const indexed = await buildWorkbookIndex(task);
        task.indexDir = indexed.indexDir;
        task.workbookProfile = indexed.manifest;
        task.indexReused = false;
        task.indexStatus = 'ready';
        touchIfExists(task.fileCacheDir);
        touchIfExists(task.indexDir);
        publish(task, 'index_ready', {
          message: '表格索引构建完成',
          profile: summarizeToolResult({ sheets: indexed.manifest.sheets }),
          task: publicTask(task),
        });
      }
    }

    assertTaskNotCancelled(task);
    setTaskState(task, 'retrieving_rules', '正在召回知识库规则');
    task.retrievedRules = retrieveRules(task.metadata, task.requirement, task.temporaryRules);

    assertTaskNotCancelled(task);
    setTaskState(task, 'exploring_data', '模型正在调用工具读取和搜索表格');
    await exploreDataWithTools(task);

    assertTaskNotCancelled(task);
    const questions = task.questions && task.questions.length
      ? task.questions
      : (task.agentPlan?.status === 'ready' ? [] : needsClarification(task));
    if (questions.length && !task.clarifications.length) {
      setTaskState(task, 'needs_clarification', '需要人工确认后继续', { questions });
      return;
    }

    assertTaskNotCancelled(task);
    setTaskState(task, 'generating_code', '正在生成 Python 处理脚本');
    writeGeneratedCode(task, await generateCode(task));
    log('info', 'code_generated', { taskId: task.id, codeLength: task.generatedCode.length });
    publish(task, 'code', { code: task.generatedCode });

    let lastError = '';
    for (let attempt = 0; attempt <= REPAIR_LIMIT; attempt += 1) {
      setTaskState(task, attempt === 0 ? 'executing' : 'repairing', attempt === 0 ? '正在沙盒执行' : `正在自修复并重试第 ${attempt} 次`);
      const result = await runSandbox(task);
      if (result.cancelled) throw cancelledError();
      if (result.ok) {
        task.outputPath = result.output;
        task.executionWarning = result.warning || '';
        task.validationReport = await validateOutput(task, result.output);
        publish(task, 'validation', {
          message: task.validationReport.ok ? '输出文件校验完成' : '输出文件校验发现问题',
          report: task.validationReport,
          task: publicTask(task),
        });
        if (task.executionWarning) {
          publish(task, 'warning', {
            message: `结果文件已生成，但执行过程中出现警告：${task.executionWarning}`,
            task: publicTask(task),
          });
        }
        log('info', 'workflow_completed', {
          taskId: task.id,
          outputPath: task.outputPath,
          outputExists: fs.existsSync(task.outputPath),
          warning: task.executionWarning,
        });
        setTaskState(task, 'completed', task.executionWarning ? '处理完成，可下载结果（执行有警告）' : '处理完成，可下载结果');
        return;
      }
      lastError = `${result.error || ''}\n${result.detail || ''}`.trim();
      publish(task, 'error', { message: lastError, attempt });
      if (attempt < REPAIR_LIMIT && process.env.OPENAI_API_KEY) {
        const fixed = await repairCode(task, lastError);
        if (fixed) writeGeneratedCode(task, fixed);
      } else if (!process.env.OPENAI_API_KEY) {
        break;
      }
    }
    setTaskState(task, 'failed', lastError || '沙盒执行失败');
  } catch (error) {
    if (isCancelledError(error) || task.cancelRequested) {
      task.indexStatus = task.indexStatus === 'indexing' ? 'cancelled' : task.indexStatus;
      if (task.state !== 'cancelled') setTaskState(task, 'cancelled', '任务已手动停止');
      log('info', 'workflow_cancelled', { taskId: task.id });
      return;
    }
    if (task.state === 'indexing') task.indexStatus = 'failed';
    log('error', 'workflow_failed', { taskId: task.id, error: error.message });
    setTaskState(task, 'failed', error.message);
  }
}

async function createTask(req, res) {
  resetRuntimeLog('new_task_request', {
    contentType: req.headers['content-type'] || '',
    contentLength: req.headers['content-length'] || '',
  });
  log('info', 'task_create_request_started', {
    contentType: req.headers['content-type'] || '',
    contentLength: req.headers['content-length'] || '',
  });
  const buffer = await readBody(req);
  const parts = parseMultipart(buffer, req.headers['content-type']);
  const file = parts.find((part) => part.name === 'file' && part.filename);
  if (!file) throw new Error('请上传文件');
  const requirement = (parts.find((part) => part.name === 'requirement')?.content.toString('utf8') || '').trim();
  const temporaryRules = (parts.find((part) => part.name === 'temporaryRules')?.content.toString('utf8') || '').trim();
  const previewRowsRaw = Number((parts.find((part) => part.name === 'previewRows')?.content.toString('utf8') || '3').trim());
  const previewRows = Math.max(1, Math.min(Number.isFinite(previewRowsRaw) ? previewRowsRaw : 3, 50));
  if (!requirement) throw new Error('请输入处理需求');

  const id = crypto.randomUUID();
  const dir = path.join(TASKS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const originalName = file.filename.replace(/[^\w\u4e00-\u9fa5.\-() ]/g, '_');
  const ext = path.extname(originalName).toLowerCase();
  const filename = originalName || `source${ext || '.xlsx'}`;
  const fileHash = crypto.createHash('sha256').update(file.content).digest('hex');
  const fileCacheDir = path.join(FILES_DIR, fileHash);
  fs.mkdirSync(fileCacheDir, { recursive: true });
  const filePath = path.join(fileCacheDir, `source${ext || '.xlsx'}`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, file.content);
  }
  touchIfExists(filePath);
  touchIfExists(fileCacheDir);
  const indexDir = path.join(fileCacheDir, 'index');
  const indexManifestPath = path.join(indexDir, 'manifest.json');
  const indexReused = fs.existsSync(indexManifestPath);
  log('info', 'task_file_saved', {
    taskId: id,
    filename,
    fileHash,
    sizeBytes: file.content.length,
    dir,
    fileCacheDir,
    indexReused,
  });

  const now = new Date().toISOString();
  const task = {
    id,
    dir,
    filePath,
    fileHash,
    fileCacheDir,
    filename,
    requirement,
    temporaryRules,
    previewRows,
    metadata: null,
    retrievedRules: [],
    clarifications: [],
    indexStatus: 'pending',
    indexDir,
    indexReused,
    workbookProfile: null,
    agentPlan: null,
    validationReport: null,
    agentTrace: [],
    agentExplorationSummary: '',
    cancelRequested: false,
    children: new Set(),
    abortController: null,
    events: [],
    state: 'uploaded',
    message: '文件已上传',
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(id, task);
  publish(task, 'state', { state: task.state, message: task.message, task: publicTask(task) });

  sendJson(res, 201, publicTask(task));

  setImmediate(async () => {
    try {
      assertTaskNotCancelled(task);
      setTaskState(task, 'metadata_ready', '正在解析元数据');
      task.metadata = await extractMetadata(filePath, filename, previewRows);
      assertTaskNotCancelled(task);
      log('info', 'metadata_extracted', {
        taskId: task.id,
        columns: task.metadata.columns.length,
        totalRows: task.metadata.totalRows,
        fileKind: task.metadata.fileKind,
        previewRows: task.metadata.previewRows,
      });
      setTaskState(task, 'metadata_ready', '元数据解析完成');
      executeWorkflow(task);
    } catch (error) {
      if (isCancelledError(error) || task.cancelRequested) {
        if (task.state !== 'cancelled') setTaskState(task, 'cancelled', '任务已手动停止');
        return;
      }
      log('error', 'metadata_extract_failed', { taskId: task.id, error: error.message });
      setTaskState(task, 'failed', error.message);
    }
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  if (url.pathname === '/api/rules' && req.method === 'GET') {
    sendJson(res, 200, loadRules());
    return;
  }

  if (url.pathname === '/api/rules' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const rules = loadRules();
    const rule = {
      id: body.id || crypto.randomUUID(),
      condition: String(body.condition || '').trim(),
      action: String(body.action || '').trim(),
      tags: Array.isArray(body.tags) ? body.tags : [],
    };
    if (!rule.condition || !rule.action) throw new Error('规则必须包含 condition 和 action');
    rules.push(rule);
    saveRules(rules);
    sendJson(res, 201, rule);
    return;
  }

  if (url.pathname.startsWith('/api/rules/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    saveRules(loadRules().filter((rule) => rule.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    await createTask(req, res);
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) {
      sendJson(res, 404, { error: '任务不存在或服务已重启' });
      return;
    }
    const action = taskMatch[2];
    if (!action && req.method === 'GET') {
      sendJson(res, 200, publicTask(task));
      return;
    }
    if (action === 'events' && req.method === 'GET') {
      log('info', 'sse_connected', { taskId: task.id, existingEvents: task.events.length });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`event: connected\n`);
      res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString(), task: publicTask(task) })}\n\n`);
      for (const event of task.events) {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      const keepAlive = setInterval(() => {
        res.write(`: keepalive ${new Date().toISOString()}\n\n`);
      }, 15000);
      if (!clients.has(task.id)) clients.set(task.id, new Set());
      clients.get(task.id).add(res);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.get(task.id)?.delete(res);
        log('info', 'sse_closed', { taskId: task.id });
      });
      return;
    }
    if (action === 'cancel' && req.method === 'POST') {
      const accepted = cancelTask(task, '任务已手动停止');
      sendJson(res, accepted ? 202 : 409, publicTask(task));
      return;
    }
    if (action === 'clarifications' && req.method === 'POST') {
      assertTaskNotCancelled(task);
      const body = await parseJsonBody(req);
      task.clarifications.push({ answer: String(body.answer || '').trim(), at: new Date().toISOString() });
      publish(task, 'clarification', { answer: body.answer });
      executeWorkflow(task);
      sendJson(res, 202, publicTask(task));
      return;
    }
    if (action === 'code' && req.method === 'GET') {
      sendText(res, 200, task.generatedCode || '', 'text/x-python; charset=utf-8');
      return;
    }
    if (action === 'output' && req.method === 'GET') {
      if (!task.outputPath || !fs.existsSync(task.outputPath)) {
        sendJson(res, 404, { error: '结果文件尚未生成' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${encodeURIComponent('output.xlsx')}"`,
      });
      fs.createReadStream(task.outputPath).pipe(res);
      return;
    }
    if (action === 'logs' && req.method === 'GET') {
      const logPath = path.join(task.dir, 'task.log');
      sendText(res, 200, fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '', 'text/plain; charset=utf-8');
      return;
    }
  }

  const staticPath = path.normalize(path.join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (staticPath.startsWith(DIST_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  sendJson(res, 404, { error: '未找到资源' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    log('error', 'request_failed', { method: req.method, url: req.url, error: error.message });
    sendJson(res, 400, { error: error.message });
  });
});

server.on('error', (error) => {
  log('error', 'server_listen_failed', { port: PORT, error: error.message });
  process.exit(1);
});

server.listen(PORT, () => {
  log('info', 'server_listening', { url: `http://localhost:${PORT}` });
});

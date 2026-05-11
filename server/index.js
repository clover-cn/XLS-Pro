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
const LOG_FILE = path.join(TASK_DIR, 'server-runtime.log');
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3100);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS || 60000);
const REPAIR_LIMIT = 3;

const tasks = new Map();
const clients = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TASK_DIR, { recursive: true });
log('info', 'server_configured', {
  port: PORT,
  taskDir: TASK_DIR,
  model: process.env.OPENAI_MODEL || '',
  hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  pythonBin: process.env.PYTHON_BIN || 'python',
});

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
  publish(task, 'state', { state, message, task: publicTask(task) });
}

function publicTask(task) {
  return {
    id: task.id,
    filename: task.filename,
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
    questions: task.questions || [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function needsClarification(task) {
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
    /INPUT_FILE\s*=\s*['"][^'"]+['"]/,
    /OUTPUT_FILE\s*=\s*['"][^'"]+['"]/,
    /import\s+os\b/,
    /\bglobals\s*\(/,
    /Alice|Bob|Charlie|dummy|示例文件|example input/i,
  ];
  return patterns.some((pattern) => pattern.test(code));
}

async function callOpenAiCompatible(messages, temperature = 0.1, context = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const startedAt = Date.now();
  const requestBody = { model, messages, temperature, stream: true };
  log('info', 'model_stream_request_started', { ...context, model, baseUrl });
  log('info', 'model_request_body', { ...context, requestBody });
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = await response.text();
    log('error', 'model_stream_request_failed', { ...context, status: response.status, detail: detail.slice(0, 500), responseBody: detail });
    throw new Error(`模型调用失败 ${response.status}: ${detail.slice(0, 500)}`);
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
      responseBody: data,
    });
    return content;
  }

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let buffer = '';
  let content = '';
  let sawFirstChunk = false;

  const consumeSseData = (rawData) => {
    if (!rawData || rawData === '[DONE]') return;
    try {
      const payload = JSON.parse(rawData);
      const delta = payload.choices && payload.choices[0] && payload.choices[0].delta;
      const text = delta && (delta.content || delta.reasoning_content || '');
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
    const { value, done } = await reader.read();
    if (done) break;
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
    responseBody: content,
  });
  return content;
}

function extractCodeBlock(text) {
  if (!text) return '';
  const match = /```(?:python)?\s*([\s\S]*?)```/i.exec(text);
  return (match ? match[1] : text).trim();
}

async function generateCode(task) {
  const prompt = [
    '你是严谨的数据处理代码生成器。只输出完整 Python 代码，不要解释，不要 Markdown。',
    '目标：根据用户需求，为当前上传文件生成定制化 pandas/openpyxl 处理脚本，并在本地沙盒执行。',
    '硬性约束：',
    '1. 必须使用全局变量 INPUT_FILE 作为输入路径，必须使用全局变量 OUTPUT_FILE 作为输出路径。',
    '2. 禁止给 INPUT_FILE 或 OUTPUT_FILE 重新赋值，禁止硬编码 input.xlsx/output.xlsx，禁止创建示例数据或示例文件。',
    '3. 必须 import pandas as pd；可使用 openpyxl、json、math、statistics、re、decimal、datetime、numpy。',
    '4. 读取 Excel 时不要假设第一行是表头。必须结合 metadata.rawRows、metadata.mergedCells、metadata.detectedHeaderRowNumber 判断真实表头；必要时用 pd.read_excel(INPUT_FILE, sheet_name=..., header=None) 自己设置列名。',
    '5. 用户可能通过“提取行数”提供多行表头、合并单元格或标题行；必须尊重这些结构信息。',
    '6. 必须生成 Excel 文件到 OUTPUT_FILE，至少包含一个结果 sheet；如果有明细，也写入单独 sheet。',
    '7. 如果需求无法从表头判断，应 raise ValueError 说明缺少哪些列或规则，不要生成无关代码。',
    `metadata_json = ${JSON.stringify(task.metadata)}`,
    `user_requirement = ${task.requirement}`,
    `temporary_rules = ${task.temporaryRules || '无'}`,
    `retrieved_rules = ${JSON.stringify(task.retrievedRules)}`,
    `clarifications = ${JSON.stringify(task.clarifications || [])}`,
  ].join('\n');
  try {
    const modelText = await callOpenAiCompatible([
      { role: 'system', content: '生成可直接执行的 Python pandas 脚本。' },
      { role: 'user', content: prompt },
    ], 0.1, { taskId: task.id, phase: 'generate_code' });
    const code = extractCodeBlock(modelText);
    if (!code || isSuspiciousGeneratedCode(code)) {
      throw new Error('模型返回了空代码、示例代码或硬编码输入输出路径，已拒绝执行。');
    }
    return code;
  } catch (error) {
    publish(task, 'error', {
      message: `模型未生成可执行的定制化代码：${error.message}`,
    });
    throw error;
  }
}

async function repairCode(task, traceback) {
  const modelText = await callOpenAiCompatible([
    { role: 'system', content: '修复 Python pandas 脚本。只输出完整 Python 代码，不要解释，不要 Markdown。' },
    { role: 'user', content: `原代码:\n${task.generatedCode}\n\n报错:\n${traceback}\n\n请修复。硬性要求：必须使用已有全局变量 INPUT_FILE 和 OUTPUT_FILE；禁止给它们重新赋值；禁止硬编码 input.xlsx/output.xlsx；禁止创建示例数据或示例文件；必须 import pandas as pd；读取 Excel 时结合 metadata 判断表头，必要时用 header=None 自动定位真实表头行。\n\nmetadata_json = ${JSON.stringify(task.metadata)}\nuser_requirement = ${task.requirement}` },
  ], 0.1, { taskId: task.id, phase: 'repair_code' });
  const code = extractCodeBlock(modelText);
  if (!code || isSuspiciousGeneratedCode(code)) {
    throw new Error('模型修复结果仍是示例代码或包含沙盒禁用/硬编码模式，已拒绝执行。');
  }
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
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
        log(parsed.ok ? 'info' : 'error', 'sandbox_finished', {
          taskId: task.id,
          ok: Boolean(parsed.ok),
          error: parsed.error || '',
          detail: (parsed.detail || stderr || '').slice(0, 500),
          outputExists: fs.existsSync(output),
        });
        resolve(parsed.ok ? { ok: true, output } : { ok: false, error: parsed.error, detail: parsed.detail || stderr });
      } catch (error) {
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

async function executeWorkflow(task) {
  try {
    log('info', 'workflow_started', { taskId: task.id, filename: task.filename });
    setTaskState(task, 'retrieving_rules', '正在召回知识库规则');
    task.retrievedRules = retrieveRules(task.metadata, task.requirement, task.temporaryRules);

    const questions = needsClarification(task);
    if (questions.length && !task.clarifications.length) {
      setTaskState(task, 'needs_clarification', '需要人工确认后继续', { questions });
      return;
    }

    setTaskState(task, 'generating_code', '正在生成 Python 处理脚本');
    writeGeneratedCode(task, await generateCode(task));
    log('info', 'code_generated', { taskId: task.id, codeLength: task.generatedCode.length });
    publish(task, 'code', { code: task.generatedCode });

    let lastError = '';
    for (let attempt = 0; attempt <= REPAIR_LIMIT; attempt += 1) {
      setTaskState(task, attempt === 0 ? 'executing' : 'repairing', attempt === 0 ? '正在沙盒执行' : `正在自修复并重试第 ${attempt} 次`);
      const result = await runSandbox(task);
      if (result.ok) {
        task.outputPath = result.output;
        log('info', 'workflow_completed', {
          taskId: task.id,
          outputPath: task.outputPath,
          outputExists: fs.existsSync(task.outputPath),
        });
        setTaskState(task, 'completed', '处理完成，可下载结果');
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
  const dir = path.join(TASK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const filename = file.filename.replace(/[^\w\u4e00-\u9fa5.\-() ]/g, '_');
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, file.content);
  log('info', 'task_file_saved', {
    taskId: id,
    filename,
    sizeBytes: file.content.length,
    dir,
  });

  const now = new Date().toISOString();
  const task = {
    id,
    dir,
    filePath,
    filename,
    requirement,
    temporaryRules,
    previewRows,
    metadata: null,
    retrievedRules: [],
    clarifications: [],
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
      setTaskState(task, 'metadata_ready', '正在解析元数据');
      task.metadata = await extractMetadata(filePath, filename, previewRows);
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
    if (action === 'clarifications' && req.method === 'POST') {
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

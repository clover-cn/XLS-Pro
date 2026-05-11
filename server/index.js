const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const DATA_DIR = path.join(ROOT, 'data');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const TASK_DIR = path.resolve(process.env.TASK_STORAGE_DIR || path.join(ROOT, '.agentic-tasks'));
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3100);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS || 60000);
const REPAIR_LIMIT = 3;

const tasks = new Map();
const clients = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TASK_DIR, { recursive: true });

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

function extractCsvMetadata(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = parseCsvLine(lines[0] || '');
  const rows = lines.slice(1).map(parseCsvLine);
  const samples = rows.slice(0, 3).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
  return {
    fileKind: 'csv',
    totalRows: rows.length,
    columns: headers.map((header, index) => ({
      name: header || `Column ${index + 1}`,
      type: inferType(rows.slice(0, 50).map((row) => row[index] || '')),
    })),
    samples,
  };
}

function extractXlsxMetadata(filePath) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN || 'python';
    const script = path.join(__dirname, 'xlsx_metadata.py');
    const child = spawn(python, [script, filePath], {
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

async function extractMetadata(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') return extractCsvMetadata(filePath);
  if (ext === '.xlsx') return extractXlsxMetadata(filePath);
  throw new Error('仅支持 .csv 和 .xlsx 文件');
}

function publish(task, type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  task.events.push(event);
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
  const headers = task.metadata.columns.map((column) => column.name).join(' ');
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

function localCode(task) {
  const columns = task.metadata.columns.map((column) => column.name);
  const amountColumn = columns.find((name) => /金额|amount|发生额|收入|支出/i.test(name))
    || columns.find((name) => /借方|debit/i.test(name))
    || columns.find((name) => /贷方|credit/i.test(name));
  const dateColumn = columns.find((name) => /日期|时间|date|time/i.test(name));
  const summaryColumn = columns.find((name) => /摘要|说明|备注|summary|description|memo/i.test(name));
  const subjectColumn = columns.find((name) => /科目|账户|account|subject/i.test(name));
  return `import pandas as pd

input_file = INPUT_FILE
output_file = OUTPUT_FILE

if input_file.lower().endswith(".csv"):
    df = pd.read_csv(input_file)
else:
    df = pd.read_excel(input_file)

amount_column = ${JSON.stringify(amountColumn || '')}
date_column = ${JSON.stringify(dateColumn || '')}
summary_column = ${JSON.stringify(summaryColumn || '')}
subject_column = ${JSON.stringify(subjectColumn || '')}

result = df.copy()

if amount_column and amount_column in result.columns:
    numeric_amount = pd.to_numeric(result[amount_column], errors="coerce").fillna(0)
else:
    numeric_amount = pd.Series([0] * len(result), index=result.index)

summary_text = result[summary_column].astype(str) if summary_column and summary_column in result.columns else pd.Series([""] * len(result), index=result.index)
subject_text = result[subject_column].astype(str) if subject_column and subject_column in result.columns else pd.Series([""] * len(result), index=result.index)

refund_mask = summary_text.str.contains("退款", na=False)
adjusted_amount = numeric_amount.where(~refund_mask, -numeric_amount.abs())

def classify_cash_flow(summary, subject, amount):
    text = f"{summary} {subject}"
    if "预付账款" in text:
        return "经营活动现金流出"
    if "退款" in text:
        return "退款调整"
    if amount >= 0:
        return "待复核现金流入"
    return "待复核现金流出"

result["AI_调整后金额"] = adjusted_amount
result["AI_现金流分类"] = [
    classify_cash_flow(summary, subject, amount)
    for summary, subject, amount in zip(summary_text, subject_text, adjusted_amount)
]
result["AI_处理说明"] = "本结果由本地沙盒脚本生成，请结合业务规则复核。"

summary = result.groupby("AI_现金流分类", dropna=False)["AI_调整后金额"].sum().reset_index()
summary = summary.rename(columns={"AI_调整后金额": "分类金额合计"})

with pd.ExcelWriter(output_file, engine="openpyxl") as writer:
    result.to_excel(writer, sheet_name="处理明细", index=False)
    summary.to_excel(writer, sheet_name="分类汇总", index=False)
`;
}

async function callOpenAiCompatible(messages, temperature = 0.1) {
  if (!process.env.OPENAI_API_KEY) return null;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型调用失败 ${response.status}: ${detail.slice(0, 500)}`);
  }
  const data = await response.json();
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

function extractCodeBlock(text) {
  if (!text) return '';
  const match = /```(?:python)?\s*([\s\S]*?)```/i.exec(text);
  return (match ? match[1] : text).trim();
}

async function generateCode(task) {
  const prompt = [
    '你是严谨的数据处理代码生成器，只输出 Python 代码，不要解释。',
    '代码只能使用 pandas/openpyxl/csv/json/math/statistics/re/decimal/datetime/numpy。',
    '输入路径来自全局变量 INPUT_FILE，输出路径必须写入全局变量 OUTPUT_FILE。',
    '必须生成 Excel 文件 output.xlsx，至少包含处理明细 sheet。',
    `文件元数据: ${JSON.stringify(task.metadata)}`,
    `用户需求: ${task.requirement}`,
    `临时规则: ${task.temporaryRules || '无'}`,
    `召回规则: ${JSON.stringify(task.retrievedRules)}`,
    `澄清回答: ${JSON.stringify(task.clarifications || [])}`,
  ].join('\n');
  const modelText = await callOpenAiCompatible([
    { role: 'system', content: '生成可直接执行的 Python pandas 脚本。' },
    { role: 'user', content: prompt },
  ]);
  return extractCodeBlock(modelText) || localCode(task);
}

async function repairCode(task, traceback) {
  const modelText = await callOpenAiCompatible([
    { role: 'system', content: '修复 Python pandas 脚本。只输出完整 Python 代码。' },
    { role: 'user', content: `原代码:\n${task.generatedCode}\n\n报错:\n${traceback}\n\n请修复，仍使用 INPUT_FILE 和 OUTPUT_FILE。` },
  ]);
  return extractCodeBlock(modelText);
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
      resolve({ ok: false, error: error.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
        resolve(parsed.ok ? { ok: true, output } : { ok: false, error: parsed.error, detail: parsed.detail || stderr });
      } catch (error) {
        resolve({ ok: false, error: stderr || stdout || error.message });
      }
    });
  });
}

async function executeWorkflow(task) {
  try {
    setTaskState(task, 'retrieving_rules', '正在召回知识库规则');
    task.retrievedRules = retrieveRules(task.metadata, task.requirement, task.temporaryRules);

    const questions = needsClarification(task);
    if (questions.length && !task.clarifications.length) {
      setTaskState(task, 'needs_clarification', '需要人工确认后继续', { questions });
      return;
    }

    setTaskState(task, 'generating_code', '正在生成 Python 处理脚本');
    writeGeneratedCode(task, await generateCode(task));
    publish(task, 'code', { code: task.generatedCode });

    let lastError = '';
    for (let attempt = 0; attempt <= REPAIR_LIMIT; attempt += 1) {
      setTaskState(task, attempt === 0 ? 'executing' : 'repairing', attempt === 0 ? '正在沙盒执行' : `正在自修复并重试第 ${attempt} 次`);
      const result = await runSandbox(task);
      if (result.ok) {
        task.outputPath = result.output;
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
    setTaskState(task, 'failed', error.message);
  }
}

async function createTask(req, res) {
  const buffer = await readBody(req);
  const parts = parseMultipart(buffer, req.headers['content-type']);
  const file = parts.find((part) => part.name === 'file' && part.filename);
  if (!file) throw new Error('请上传文件');
  const requirement = (parts.find((part) => part.name === 'requirement')?.content.toString('utf8') || '').trim();
  const temporaryRules = (parts.find((part) => part.name === 'temporaryRules')?.content.toString('utf8') || '').trim();
  if (!requirement) throw new Error('请输入处理需求');

  const id = crypto.randomUUID();
  const dir = path.join(TASK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const filename = file.filename.replace(/[^\w\u4e00-\u9fa5.\-() ]/g, '_');
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, file.content);

  const now = new Date().toISOString();
  const task = {
    id,
    dir,
    filePath,
    filename,
    requirement,
    temporaryRules,
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

  sendJson(res, 201, publicTask(task));

  setImmediate(async () => {
    try {
      setTaskState(task, 'metadata_ready', '正在解析元数据');
      task.metadata = await extractMetadata(filePath, filename);
      setTaskState(task, 'metadata_ready', '元数据解析完成');
      executeWorkflow(task);
    } catch (error) {
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
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      for (const event of task.events) {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!clients.has(task.id)) clients.set(task.id, new Set());
      clients.get(task.id).add(res);
      req.on('close', () => clients.get(task.id)?.delete(res));
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
  }

  const staticPath = path.normalize(path.join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (staticPath.startsWith(DIST_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  sendJson(res, 404, { error: '未找到资源' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, 400, { error: error.message }));
});

server.listen(PORT, () => {
  console.log(`Agentic Workflow API listening on http://localhost:${PORT}`);
});

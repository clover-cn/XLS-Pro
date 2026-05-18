const fs = require('fs');
const path = require('path');

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
const WORKBOOK_INDEX_VERSION = 2;
const AGENT_TOOL_CALL_LIMIT = 20;
const AGENT_TOOL_CALLS_PER_ROUND = 3;
const AGENT_FORCE_FINAL_REMAINING = 1;
const AGENT_TOOL_BUDGET_EXTENSION_CALLS = Number(process.env.AGENT_TOOL_BUDGET_EXTENSION_CALLS || 8);
const AGENT_TOOL_BUDGET_EXTENSION_LIMIT = Number(process.env.AGENT_TOOL_BUDGET_EXTENSION_LIMIT || 2);
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
  'classifying',
  'generating_code',
  'executing',
  'repairing',
  'validating_output',
]);

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

module.exports = {
  ROOT,
  DATA_DIR,
  RULES_FILE,
  TASK_DIR,
  FILES_DIR,
  TASKS_DIR,
  LOG_FILE,
  DIST_DIR,
  PORT,
  SANDBOX_TIMEOUT_MS,
  REPAIR_LIMIT,
  WORKBOOK_INDEX_VERSION,
  AGENT_TOOL_CALL_LIMIT,
  AGENT_TOOL_CALLS_PER_ROUND,
  AGENT_FORCE_FINAL_REMAINING,
  AGENT_TOOL_BUDGET_EXTENSION_CALLS,
  AGENT_TOOL_BUDGET_EXTENSION_LIMIT,
  EXCEL_TOOL_TIMEOUT_MS,
  WORKBOOK_INDEX_TIMEOUT_MS,
  TASK_CACHE_TTL_MS,
  TERMINAL_STATES,
  ACTIVE_STATES,
  loadEnvFile,
  resolveProjectPath,
};

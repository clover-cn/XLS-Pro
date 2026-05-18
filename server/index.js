const http = require('http');
const fs = require('fs');
const { DATA_DIR, TASK_DIR, FILES_DIR, TASKS_DIR, PORT, TASK_CACHE_TTL_MS } = require('./config');
const { log, resetRuntimeLog } = require('./logger');
const { createCacheMaintenance } = require('./cache');
const { extractMetadata } = require('./metadata');
const { retrieveRules } = require('./rules');
const { summarizeToolResult } = require('./tool-summary');
const { createTaskState } = require('./task-state');
const { createAgentServices } = require('./agent-services');
const { createSemanticCache } = require('./semantic-cache');
const { createWorkflow } = require('./workflow');
const { createRouter } = require('./routes');
const { sendJson } = require('./http-utils');

const tasks = new Map();
const clients = new Map();
const cache = createCacheMaintenance({ log });
const semanticCache = createSemanticCache({ log });
const taskState = createTaskState({ log, clients });
const agentServices = createAgentServices({
  tasks,
  log,
  publish: taskState.publish,
  publicTask: taskState.publicTask,
  assertTaskNotCancelled: taskState.assertTaskNotCancelled,
  cancelledError: taskState.cancelledError,
  trackChildProcess: taskState.trackChildProcess,
  isPathInside: cache.isPathInside,
});
const workflow = createWorkflow({
  log,
  publish: taskState.publish,
  publicTask: taskState.publicTask,
  setTaskState: taskState.setTaskState,
  assertTaskNotCancelled: taskState.assertTaskNotCancelled,
  cancelledError: taskState.cancelledError,
  isCancelledError: taskState.isCancelledError,
  trackChildProcess: taskState.trackChildProcess,
  isPathInside: cache.isPathInside,
  touchIfExists: cache.touchIfExists,
  extractMetadata,
  retrieveRules,
  summarizeToolResult,
  buildWorkbookIndex: agentServices.buildWorkbookIndex,
  tryPlanFromMetadata: agentServices.tryPlanFromMetadata,
  exploreDataWithTools: agentServices.exploreDataWithTools,
  routeTaskIntent: agentServices.routeTaskIntent,
  classifySemanticItems: agentServices.classifySemanticItems,
  needsClarification: agentServices.needsClarification,
  generateCode: agentServices.generateCode,
  repairCode: agentServices.repairCode,
  semanticCache,
});
const route = createRouter({
  tasks,
  clients,
  log,
  resetRuntimeLog,
  publish: taskState.publish,
  publicTask: taskState.publicTask,
  setTaskState: taskState.setTaskState,
  assertTaskNotCancelled: taskState.assertTaskNotCancelled,
  cancelTask: taskState.cancelTask,
  isCancelledError: taskState.isCancelledError,
  touchIfExists: cache.touchIfExists,
  extractMetadata,
  executeWorkflow: workflow.executeWorkflow,
});

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
cache.cleanupOldTaskCache();

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

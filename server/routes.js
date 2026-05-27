const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIST_DIR, FILES_DIR, TASKS_DIR } = require('./config');
const { sendJson, sendText, readBody, parseJsonBody, parseMultipart } = require('./http-utils');
const { loadRules, saveRules } = require('./rules');

function createRouter({
  tasks,
  clients,
  log,
  resetRuntimeLog,
  publish,
  publicTask,
  setTaskState,
  assertTaskNotCancelled,
  cancelTask,
  isCancelledError,
  touchIfExists,
  extractMetadata,
  refineTaskDraft,
  executeWorkflow,
}) {
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
      originalRequirement: requirement,
      requirement,
      temporaryRules,
      previewRows,
      metadata: null,
      retrievedRules: [],
      clarifications: [],
      chatMessages: [],
      executionSpec: null,
      draftTrace: [],
      draftReady: false,
      failedStage: '',
      lastError: '',
      retryCount: 0,
      retrying: false,
      resumeStage: 'uploaded',
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
        if (requirement) {
          task.chatMessages.push({ role: 'user', content: requirement, at: new Date().toISOString() });
          publish(task, 'draft_message', { message: requirement, role: 'user', task: publicTask(task) });
          setTaskState(task, 'drafting', '正在理解需求并准备澄清问题');
          await refineTaskDraft(task);
        } else {
          const greeting = '文件结构已读取。请告诉我你希望对这个表格做什么，我会先确认需求再开始执行。';
          task.chatMessages.push({ role: 'assistant', content: greeting, at: new Date().toISOString(), ready: false });
          setTaskState(task, 'drafting', '等待输入处理需求');
          publish(task, 'draft_message', { message: greeting, role: 'assistant', ready: false, task: publicTask(task) });
        }
      } catch (error) {
        if (isCancelledError(error) || task.cancelRequested) {
          if (task.state !== 'cancelled') setTaskState(task, 'cancelled', '任务已手动停止');
          return;
        }
        log('error', 'draft_refine_failed', { taskId: task.id, error: error.message });
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
      if (action === 'retry' && req.method === 'POST') {
        if (task.state !== 'failed') {
          sendJson(res, 409, { error: '只有失败任务可以继续执行', task: publicTask(task) });
          return;
        }
        task.cancelRequested = false;
        task.abortController = null;
        task.retrying = true;
        task.retryCount = (task.retryCount || 0) + 1;
        task.lastError = task.message || task.lastError || '';
        publish(task, 'resume', {
          message: `已请求继续执行，将从 ${task.failedStage || task.resumeStage || '最近可恢复阶段'} 开始`,
          failedStage: task.failedStage || '',
          retryCount: task.retryCount,
          task: publicTask(task),
        });
        sendJson(res, 202, publicTask(task));
        setImmediate(() => executeWorkflow(task));
        return;
      }
      if (action === 'messages' && req.method === 'POST') {
        assertTaskNotCancelled(task);
        const body = await parseJsonBody(req);
        const content = String(body.message || body.answer || '').trim();
        if (!content) throw new Error('消息不能为空');
        if (!Array.isArray(task.chatMessages)) task.chatMessages = [];
        const userMessage = { role: 'user', content, at: new Date().toISOString() };
        task.chatMessages.push(userMessage);
        publish(task, 'draft_message', { message: content, role: 'user', task: publicTask(task) });
        const wantsRevision = Boolean(body.forceRefine || body.revise)
          || /修改需求|调整需求|重新整理|重新确认|改一下|再改|补充需求/.test(content);
        if (task.state === 'ready_to_execute' && !wantsRevision) {
          const reply = '需求已确认，请点击“确认并开始执行”按钮；如需调整需求，请明确说明“修改需求”并补充新的要求。';
          task.chatMessages.push({
            role: 'assistant',
            content: reply,
            at: new Date().toISOString(),
            ready: true,
            openQuestions: [],
            executionSpec: task.executionSpec,
          });
          publish(task, 'draft_message', {
            message: reply,
            role: 'assistant',
            ready: true,
            openQuestions: [],
            executionSpec: task.executionSpec,
            task: publicTask(task),
          });
          sendJson(res, 202, publicTask(task));
          return;
        }
        if (task.state === 'needs_clarification') {
          task.clarifications.push({ answer: content, at: userMessage.at });
          task.questions = [];
          publish(task, 'clarification', { answer: content, task: publicTask(task) });
          sendJson(res, 202, publicTask(task));
          setImmediate(() => executeWorkflow(task));
          return;
        }
        if (!['drafting', 'ready_to_execute', 'metadata_ready'].includes(task.state)) {
          sendJson(res, 409, { error: '当前任务状态不能继续对话', task: publicTask(task) });
          return;
        }
        if (wantsRevision) {
          task.agentPlan = null;
          task.agentExplorationSummary = '';
          task.explorationCheckpoint = null;
        }
        task.draftReady = false;
        setTaskState(task, 'drafting', '正在理解需求并准备澄清问题');
        sendJson(res, 202, publicTask(task));
        setImmediate(async () => {
          try {
            await refineTaskDraft(task);
          } catch (error) {
            if (isCancelledError(error) || task.cancelRequested) {
              if (task.state !== 'cancelled') setTaskState(task, 'cancelled', '任务已手动停止');
              return;
            }
            log('error', 'draft_refine_failed', { taskId: task.id, error: error.message });
            setTaskState(task, 'failed', error.message || '需求澄清失败');
          }
        });
        return;
      }
      if (action === 'execute' && req.method === 'POST') {
        if (task.state !== 'ready_to_execute' || !task.executionSpec?.finalRequirement) {
          sendJson(res, 409, { error: '需求尚未确认，不能开始执行', task: publicTask(task) });
          return;
        }
        task.requirement = String(task.executionSpec.finalRequirement || '').trim();
        task.clarifications = (task.chatMessages || [])
          .filter((message) => message.role === 'user')
          .map((message) => ({ answer: message.content, at: message.at }));
        task.questions = [];
        task.draftReady = true;
        task.cancelRequested = false;
        task.abortController = null;
        publish(task, 'resume', {
          message: '已确认需求，开始执行任务',
          executionSpec: task.executionSpec,
          task: publicTask(task),
        });
        sendJson(res, 202, publicTask(task));
        setImmediate(() => executeWorkflow(task));
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

  return route;
}

module.exports = { createRouter };

const fs = require('fs');
const path = require('path');
const { ACTIVE_STATES } = require('./config');
const { summarizeToolResult } = require('./tool-summary');

function createTaskState({ log, clients }) {
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
    const previousState = task.state;
    if (state === 'failed') {
      task.failedStage = extra.failedStage || task.resumeStage || previousState || 'uploaded';
      task.lastError = message || task.lastError || '';
      task.retrying = false;
    } else if (!['completed', 'cancelled'].includes(state)) {
      task.resumeStage = state;
      if (state !== 'needs_clarification') task.failedStage = '';
    } else {
      task.retrying = false;
      task.failedStage = '';
    }
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
      chatMessages: task.chatMessages || [],
      executionSpec: task.executionSpec || null,
      draftTrace: task.draftTrace || [],
      draftReady: Boolean(task.draftReady),
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
      failedStage: task.failedStage || '',
      lastError: task.lastError || '',
      retryCount: task.retryCount || 0,
      retrying: Boolean(task.retrying),
      resumeStage: task.resumeStage || '',
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

  return {
    appendTaskLog,
    publish,
    setTaskState,
    publicTask,
    cancelledError,
    isCancelledError,
    assertTaskNotCancelled,
    trackChildProcess,
    cancelTask,
  };
}

module.exports = { createTaskState };

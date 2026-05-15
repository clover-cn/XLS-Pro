const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SANDBOX_TIMEOUT_MS, REPAIR_LIMIT, WORKBOOK_INDEX_VERSION } = require('./config');
const { summarizeToolResult } = require('./tool-summary');

function createWorkflow({
  log,
  publish,
  publicTask,
  setTaskState,
  assertTaskNotCancelled,
  cancelledError,
  isCancelledError,
  trackChildProcess,
  isPathInside,
  touchIfExists,
  extractMetadata,
  retrieveRules,
  buildWorkbookIndex,
  tryPlanFromMetadata,
  exploreDataWithTools,
  needsClarification,
  generateCode,
  repairCode,
}) {
  function writeGeneratedCode(task, code) {
    task.generatedCode = code;
    const scriptPath = path.join(task.dir, 'generated.py');
    fs.writeFileSync(scriptPath, `${code.trim()}\n`, 'utf8');
    return scriptPath;
  }
  
  function ensureSandboxInputFile(task) {
    const sourcePath = path.resolve(task.filePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('源文件不存在');
    }
    const ext = path.extname(task.filename || sourcePath) || path.extname(sourcePath) || '.xlsx';
    const sandboxInput = path.join(task.dir, `input${ext.toLowerCase()}`);
    if (!isPathInside(task.dir, sandboxInput)) {
      throw new Error('沙盒输入文件路径非法');
    }
    const sourceStat = fs.statSync(sourcePath);
    const targetExists = fs.existsSync(sandboxInput);
    const targetStat = targetExists ? fs.statSync(sandboxInput) : null;
    if (!targetExists || targetStat.size !== sourceStat.size) {
      fs.copyFileSync(sourcePath, sandboxInput);
    }
    return sandboxInput;
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
      let sandboxInput;
      try {
        sandboxInput = ensureSandboxInputFile(task);
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      log('info', 'sandbox_started', {
        taskId: task.id,
        python,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        script,
        input: sandboxInput,
        output,
      });
      const child = spawn(python, [runner, script, sandboxInput, output, String(timeoutSeconds)], {
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

  function runWorkbookPatch(task) {
    return new Promise((resolve) => {
      try {
        assertTaskNotCancelled(task);
      } catch (error) {
        resolve({ ok: false, cancelled: true, error: error.message });
        return;
      }
      const patch = task.agentPlan?.workbookPatch;
      if (!patch) {
        resolve({ ok: false, error: '缺少 workbookPatch 执行计划' });
        return;
      }
      const python = process.env.PYTHON_BIN || 'python';
      const script = path.join(__dirname, 'workbook_patch.py');
      const output = path.join(task.dir, 'output.xlsx');
      let sandboxInput;
      try {
        sandboxInput = ensureSandboxInputFile(task);
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      log('info', 'workbook_patch_started', {
        taskId: task.id,
        python,
        input: sandboxInput,
        output,
        patch,
      });
      const child = spawn(python, [script, sandboxInput, output, JSON.stringify(patch)], {
        cwd: task.dir,
        windowsHide: true,
        env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      trackChildProcess(task, child, 'workbook-patch');
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), SANDBOX_TIMEOUT_MS + 1000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        log('error', 'workbook_patch_spawn_failed', { taskId: task.id, error: error.message });
        resolve({ ok: false, error: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (task.cancelRequested) {
          resolve({ ok: false, cancelled: true, error: '任务已手动停止' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
        } catch (error) {
          resolve({ ok: false, error: `格式保留修改输出无法解析: ${(stderr || stdout || error.message).slice(0, 500)}` });
          return;
        }
        if (code !== 0 || !parsed.ok) {
          resolve({ ok: false, error: parsed.error || stderr || `格式保留修改失败，退出码 ${code}`, detail: parsed.detail || '' });
          return;
        }
        log('info', 'workbook_patch_finished', {
          taskId: task.id,
          changedCellCount: parsed.data?.changedCellCount || 0,
          outputExists: fs.existsSync(output),
        });
        resolve({ ok: true, output, patchResult: parsed.data });
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

      assertTaskNotCancelled(task);
      setTaskState(task, 'exploring_data', '正在基于预览判断是否可直接处理');
      const hasMetadataPlan = tryPlanFromMetadata(task);

      if (!hasMetadataPlan && task.indexStatus !== 'ready') {
        const manifestPath = path.join(task.indexDir || path.join(task.dir, 'index'), 'manifest.json');
        let reusableManifest = null;
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.version === WORKBOOK_INDEX_VERSION) {
            reusableManifest = manifest;
          } else {
            log('info', 'workbook_index_version_mismatch', {
              taskId: task.id,
              currentVersion: manifest.version || 0,
              expectedVersion: WORKBOOK_INDEX_VERSION,
            });
          }
        }
        if (reusableManifest) {
          task.workbookProfile = reusableManifest;
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
      if (!hasMetadataPlan) {
        setTaskState(task, 'retrieving_rules', '正在召回知识库规则');
        task.retrievedRules = retrieveRules(task.metadata, task.requirement, task.temporaryRules);
  
        assertTaskNotCancelled(task);
        setTaskState(task, 'exploring_data', '模型正在调用工具读取和搜索表格');
        await exploreDataWithTools(task);
      }
  
      assertTaskNotCancelled(task);
      const questions = task.questions && task.questions.length
        ? task.questions
        : (task.agentPlan?.status === 'ready' ? [] : needsClarification(task));
      if (questions.length && !task.clarifications.length) {
        setTaskState(task, 'needs_clarification', '需要人工确认后继续', { questions });
        return;
      }

      if (task.agentPlan?.executionMode === 'workbook_patch') {
        assertTaskNotCancelled(task);
        setTaskState(task, 'executing', '正在按原格式修改工作簿');
        task.generatedCode = '# 使用格式保留型 workbook_patch 工具执行，本任务未生成 pandas 脚本。';
        const result = await runWorkbookPatch(task);
        if (result.cancelled) throw cancelledError();
        if (!result.ok) {
          const message = `${result.error || ''}\n${result.detail || ''}`.trim();
          publish(task, 'error', { message });
          setTaskState(task, 'failed', message || '格式保留修改失败');
          return;
        }
        task.outputPath = result.output;
        task.executionWarning = '';
        task.validationReport = await validateOutput(task, result.output);
        task.validationReport.patchResult = result.patchResult;
        publish(task, 'validation', {
          message: `格式保留修改完成：已修改 ${result.patchResult?.changedCellCount || 0} 个单元格`,
          report: task.validationReport,
          task: publicTask(task),
        });
        log('info', 'workflow_completed', {
          taskId: task.id,
          mode: 'workbook_patch',
          outputPath: task.outputPath,
          changedCellCount: result.patchResult?.changedCellCount || 0,
        });
        setTaskState(task, 'completed', '处理完成，可下载结果');
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

  return {
    executeWorkflow,
    validateOutput,
    runSandbox,
    runWorkbookPatch,
    writeGeneratedCode,
  };
}

module.exports = { createWorkflow };

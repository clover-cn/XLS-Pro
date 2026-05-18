const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SANDBOX_TIMEOUT_MS, REPAIR_LIMIT, WORKBOOK_INDEX_VERSION, SEMANTIC_MAX_UNIQUE } = require('./config');
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
  routeTaskIntent,
  classifySemanticItems,
  needsClarification,
  generateCode,
  repairCode,
  semanticCache,
}) {
  function writeGeneratedCode(task, code) {
    task.generatedCode = code;
    const scriptPath = path.join(task.dir, 'generated.py');
    fs.writeFileSync(scriptPath, `${code.trim()}\n`, 'utf8');
    return scriptPath;
  }

  function loadGeneratedCode(task) {
    if (task.generatedCode) return task.generatedCode;
    const scriptPath = path.join(task.dir, 'generated.py');
    if (!fs.existsSync(scriptPath)) return '';
    const code = fs.readFileSync(scriptPath, 'utf8');
    task.generatedCode = code;
    return code;
  }

  function existingOutputPath(task) {
    if (task.outputPath && fs.existsSync(task.outputPath)) return task.outputPath;
    const output = path.join(task.dir, 'output.xlsx');
    if (fs.existsSync(output)) {
      task.outputPath = output;
      return output;
    }
    return '';
  }

  function hasUsableAgentPlan(task) {
    return task.agentPlan?.status === 'ready';
  }

  function isRetrying(task) {
    return Boolean(task.retrying);
  }

  function semanticPlanForTask(task) {
    const route = task.agentPlan?.route || {};
    const plan = task.agentPlan?.semanticPlan || {};
    return {
      domain: route.domain_hint || 'general',
      taxonomyVersion: plan.taxonomy_version || 'default-v1',
      promptVersion: plan.prompt_version || 'semantic-mapping-v1',
      subjectColumns: plan.subject_columns || [],
      taxonomy: plan.taxonomy || [],
    };
  }

  function runSemanticExtract(task, plan) {
    return new Promise((resolve) => {
      const python = process.env.PYTHON_BIN || 'python';
      const script = path.join(__dirname, 'semantic_tools.py');
      const outputJson = path.join(task.dir, 'semantic-items.json');
      let sandboxInput;
      try {
        sandboxInput = ensureSandboxInputFile(task);
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      const toolPlan = {
        metadata: task.metadata,
        sheetName: task.metadata?.sheetName || '',
        headerRowNumber: task.metadata?.detectedHeaderRowNumber || 1,
        semanticPlan: {
          subject_columns: plan.subjectColumns,
        },
        maxUnique: SEMANTIC_MAX_UNIQUE,
      };
      const child = spawn(python, [script, 'extract', sandboxInput, outputJson, JSON.stringify(toolPlan)], {
        cwd: task.dir,
        windowsHide: true,
        env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      trackChildProcess(task, child, 'semantic-extract');
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('close', (code) => {
        if (task.cancelRequested) {
          resolve({ ok: false, cancelled: true, error: '任务已手动停止' });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
          if (code !== 0 || !parsed.ok) {
            resolve({ ok: false, error: parsed.error || stderr || `语义唯一值提取失败，退出码 ${code}` });
            return;
          }
          resolve({ ok: true, data: parsed.data, outputJson });
        } catch (error) {
          resolve({ ok: false, error: stderr || stdout || error.message });
        }
      });
    });
  }

  function semanticApplicationCode(task, extraction, mappings) {
    const metadata = task.metadata || {};
    const sheetName = metadata.sheetName || '';
    const headerRowNumber = Number(metadata.detectedHeaderRowNumber || 1);
    const subjectColumns = extraction.subjectColumns || [];
    const mapping = {};
    const confidence = {};
    const source = {};
    for (const item of mappings) {
      mapping[item.key] = item.label || '未分类';
      confidence[item.key] = Number(item.confidence || 0);
      source[item.key] = item.source || 'llm';
    }
    return `import pandas as pd

SHEET_NAME = ${JSON.stringify(sheetName)}
HEADER_ROW_NUMBER = ${JSON.stringify(headerRowNumber)}
SUBJECT_COLUMNS = ${JSON.stringify(subjectColumns)}
SEMANTIC_MAPPING = ${JSON.stringify(mapping, null, 2)}
SEMANTIC_CONFIDENCE = ${JSON.stringify(confidence, null, 2)}
SEMANTIC_SOURCE = ${JSON.stringify(source, null, 2)}
SEPARATOR = "\\u241f"

def make_unique(columns):
    seen = {}
    output = []
    for column in columns:
        text = str(column).strip()
        if not text or text.lower().startswith("unnamed"):
            text = "Column " + str(len(output) + 1)
        count = seen.get(text, 0)
        seen[text] = count + 1
        output.append(text if count == 0 else text + "_" + str(count + 1))
    return output

def read_table():
    if str(INPUT_FILE).lower().endswith(".csv"):
        raw = pd.read_csv(INPUT_FILE, header=None, dtype=object)
    else:
        excel = pd.ExcelFile(INPUT_FILE)
        sheet = SHEET_NAME if SHEET_NAME in excel.sheet_names else excel.sheet_names[0]
        raw = pd.read_excel(INPUT_FILE, sheet_name=sheet, header=None, dtype=object)
    header_index = max(0, int(HEADER_ROW_NUMBER) - 1)
    headers = make_unique(raw.iloc[header_index].tolist())
    df = raw.iloc[header_index + 1:].copy()
    df.columns = headers
    return df.dropna(how="all").reset_index(drop=True)

def build_key(row):
    values = []
    for column in SUBJECT_COLUMNS:
        value = row[column] if column in row.index and pd.notna(row[column]) else ""
        values.append(str(value).strip())
    return SEPARATOR.join(values)

df = read_table()
missing = [column for column in SUBJECT_COLUMNS if column not in df.columns]
if missing:
    raise ValueError("缺少语义贴标列: " + ",".join(missing) + "；当前列名: " + ",".join([str(c) for c in df.columns]))

result = df.copy()
result["AI_语义Key"] = result.apply(build_key, axis=1)
result["AI_语义标签"] = result["AI_语义Key"].map(SEMANTIC_MAPPING).fillna("未分类")
result["AI_语义置信度"] = result["AI_语义Key"].map(SEMANTIC_CONFIDENCE).fillna(0)
result["AI_语义来源"] = result["AI_语义Key"].map(SEMANTIC_SOURCE).fillna("missing")

numeric_columns = []
for column in result.columns:
    converted = pd.to_numeric(result[column], errors="coerce")
    if converted.notna().sum() > 0 and column not in ["AI_语义置信度"]:
        result[column + "__数值"] = converted.fillna(0)
        numeric_columns.append(column + "__数值")

summary = result.groupby("AI_语义标签", dropna=False).size().reset_index(name="行数")
for column in numeric_columns[:8]:
    sums = result.groupby("AI_语义标签", dropna=False)[column].sum().reset_index(name=column.replace("__数值", "_合计"))
    summary = summary.merge(sums, on="AI_语义标签", how="left")

review = result[(result["AI_语义标签"] == "未分类") | (result["AI_语义置信度"] < 0.6)].copy()
cache_stats = pd.DataFrame([
    {"指标": "语义列", "值": " + ".join(SUBJECT_COLUMNS)},
    {"指标": "映射条数", "值": len(SEMANTIC_MAPPING)},
    {"指标": "低置信度或未分类行数", "值": len(review)},
])

with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl") as writer:
    summary.to_excel(writer, sheet_name="语义汇总", index=False)
    result.to_excel(writer, sheet_name="贴标明细", index=False)
    review.to_excel(writer, sheet_name="待复核", index=False)
    cache_stats.to_excel(writer, sheet_name="缓存统计", index=False)
`;
  }

  async function executeSemanticWorkflow(task) {
    const plan = semanticPlanForTask(task);
    setTaskState(task, 'classifying', '语义模式：正在提取唯一值组合');
    const extractionResult = await runSemanticExtract(task, plan);
    if (extractionResult.cancelled) throw cancelledError();
    if (!extractionResult.ok) {
      setTaskState(task, 'failed', extractionResult.error || '语义唯一值提取失败');
      return;
    }
    const extraction = extractionResult.data;
    task.semanticExtraction = extraction;
    publish(task, 'classify_progress', {
      message: `提取到 ${extraction.totalUnique} 个唯一值组合，准备语义映射`,
      phase: 'extract_done',
      total: extraction.totalUnique,
      subjectColumns: extraction.subjectColumns,
      task: publicTask(task),
    });

    const items = extraction.items || [];
    const cachePayload = {
      domain: plan.domain,
      taxonomyVersion: plan.taxonomyVersion,
      promptVersion: plan.promptVersion,
      keys: items.map((item) => ({ key: item.key })),
    };
    const cacheHits = semanticCache.lookup(cachePayload).hits || [];
    const hitMap = new Map(cacheHits.map((item) => [item.key, { ...item, source: 'cache' }]));
    const missingItems = items.filter((item) => !hitMap.has(item.key));
    publish(task, 'classify_progress', {
      message: `缓存命中 ${cacheHits.length} 条历史分类，剩余 ${missingItems.length} 条需要 LLM 分类`,
      cached: cacheHits.length,
      remaining: missingItems.length,
      total: items.length,
      task: publicTask(task),
    });

    const llmMappings = await classifySemanticItems(task, missingItems, {
      subject_columns: extraction.subjectColumns,
      taxonomy: plan.taxonomy,
    });
    if (llmMappings.length) {
      semanticCache.upsert({
        domain: plan.domain,
        taxonomyVersion: plan.taxonomyVersion,
        promptVersion: plan.promptVersion,
        model: process.env.OPENAI_MODEL || '',
        source: 'llm',
        mappings: llmMappings,
      });
    }
    const allMappings = [
      ...cacheHits.map((item) => ({ ...item, source: 'cache' })),
      ...llmMappings,
    ];
    fs.writeFileSync(path.join(task.dir, 'semantic-mapping.json'), JSON.stringify({
      plan,
      subjectColumns: extraction.subjectColumns,
      mappings: allMappings,
    }, null, 2), 'utf8');
    publish(task, 'agent_summary', {
      message: `语义映射完成：${allMappings.length} 个组合已分类，其中缓存命中 ${cacheHits.length} 个`,
      task: publicTask(task),
    });

    setTaskState(task, 'generating_code', '语义模式：生成贴标+汇总脚本');
    writeGeneratedCode(task, semanticApplicationCode(task, extraction, allMappings));
    publish(task, 'code', { code: task.generatedCode, stage: 'semantic_application' });
    setTaskState(task, 'executing', '正在沙盒执行');
    const result = await runSandbox(task);
    if (result.cancelled) throw cancelledError();
    if (!result.ok) {
      const message = `${result.error || ''}\n${result.detail || ''}`.trim();
      publish(task, 'error', { message });
      setTaskState(task, 'failed', message || '语义贴标脚本执行失败');
      return;
    }
    task.outputPath = result.output;
    task.executionWarning = result.warning || '';
    setTaskState(task, 'validating_output', '正在校验输出文件');
    task.validationReport = await validateOutput(task, result.output);
    publish(task, 'validation', {
      message: task.validationReport.ok ? '输出文件校验完成' : '输出文件校验发现问题',
      report: task.validationReport,
      task: publicTask(task),
    });
    setTaskState(task, 'completed', task.executionWarning ? '处理完成，可下载结果（执行有警告）' : '处理完成，可下载结果');
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
      const resumeFailedStage = task.failedStage || '';
      log('info', 'workflow_started', {
        taskId: task.id,
        filename: task.filename,
        retryCount: task.retryCount || 0,
        failedStage: resumeFailedStage,
      });

      if (isRetrying(task)) {
        publish(task, 'resume', {
          message: `继续执行任务：从 ${resumeFailedStage || task.resumeStage || '最近可恢复阶段'} 开始`,
          failedStage: resumeFailedStage,
          retryCount: task.retryCount || 0,
          task: publicTask(task),
        });
      }

      if (!task.metadata) {
        assertTaskNotCancelled(task);
        setTaskState(task, 'metadata_ready', '正在解析元数据');
        task.metadata = await extractMetadata(task.filePath, task.filename, task.previewRows);
        log('info', 'metadata_extracted', {
          taskId: task.id,
          columns: task.metadata.columns.length,
          totalRows: task.metadata.totalRows,
          fileKind: task.metadata.fileKind,
          previewRows: task.metadata.previewRows,
        });
        setTaskState(task, 'metadata_ready', '元数据解析完成');
      }

      assertTaskNotCancelled(task);
      let hasMetadataPlan = hasUsableAgentPlan(task);
      if (!hasMetadataPlan) {
        setTaskState(task, 'exploring_data', '正在基于预览判断是否可直接处理');
        hasMetadataPlan = tryPlanFromMetadata(task);
      }

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
      if (!hasMetadataPlan && !hasUsableAgentPlan(task)) {
        if (!task.retrievedRules || !task.retrievedRules.length) {
          setTaskState(task, 'retrieving_rules', '正在召回知识库规则');
          task.retrievedRules = retrieveRules(task.metadata, task.requirement, task.temporaryRules);
        }
  
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
      await routeTaskIntent(task);
      const route = task.agentPlan?.route || {};
      const semanticRequired = Boolean(route.semantic_required)
        || ['semantic', 'semantic_mapping', 'hybrid'].includes(route.task_type);
      if (semanticRequired) {
        await executeSemanticWorkflow(task);
        return;
      }
  
      assertTaskNotCancelled(task);
      const outputForValidation = resumeFailedStage === 'validating_output' ? existingOutputPath(task) : '';
      if (outputForValidation) {
        setTaskState(task, 'validating_output', '正在校验输出文件');
        task.validationReport = await validateOutput(task, outputForValidation);
        publish(task, 'validation', {
          message: task.validationReport.ok ? '输出文件校验完成' : '输出文件校验发现问题',
          report: task.validationReport,
          task: publicTask(task),
        });
        setTaskState(task, 'completed', task.executionWarning ? '处理完成，可下载结果（执行有警告）' : '处理完成，可下载结果');
        return;
      }

      const existingCode = loadGeneratedCode(task);
      if (existingCode) {
        publish(task, 'resume', {
          message: '复用已生成的 Python 脚本，直接继续沙盒执行',
          task: publicTask(task),
        });
      } else {
        setTaskState(task, 'generating_code', '正在生成 Python 处理脚本');
        writeGeneratedCode(task, await generateCode(task));
        log('info', 'code_generated', { taskId: task.id, codeLength: task.generatedCode.length });
        publish(task, 'code', { code: task.generatedCode });
      }
  
      let lastError = '';
      for (let attempt = 0; attempt <= REPAIR_LIMIT; attempt += 1) {
        setTaskState(task, attempt === 0 ? 'executing' : 'repairing', attempt === 0 ? '正在沙盒执行' : `正在自修复并重试第 ${attempt} 次`);
        const result = await runSandbox(task);
        if (result.cancelled) throw cancelledError();
        if (result.ok) {
          task.outputPath = result.output;
          task.executionWarning = result.warning || '';
          setTaskState(task, 'validating_output', '正在校验输出文件');
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
    } finally {
      if (task.state !== 'failed') task.retrying = false;
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

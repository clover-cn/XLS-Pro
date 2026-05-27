const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  TASK_DIR,
  WORKBOOK_INDEX_VERSION,
  WORKBOOK_INDEX_TIMEOUT_MS,
  EXCEL_TOOL_TIMEOUT_MS,
  DRAFT_TOOL_CALL_LIMIT,
  DRAFT_TOOL_ROUND_LIMIT,
  AGENT_TOOL_CALL_LIMIT,
  AGENT_TOOL_CALLS_PER_ROUND,
  AGENT_FORCE_FINAL_REMAINING,
  AGENT_TOOL_BUDGET_EXTENSION_CALLS,
  AGENT_TOOL_BUDGET_EXTENSION_LIMIT,
  SEMANTIC_BATCH_SIZE,
} = require('./config');
const {
  summarizeToolArgs,
  summarizeToolResult,
  compactText,
  compactToolContentForModel,
} = require('./tool-summary');

function createAgentServices({
  tasks,
  log,
  publish,
  publicTask,
  setTaskState,
  assertTaskNotCancelled,
  cancelledError,
  trackChildProcess,
  isPathInside,
}) {
  function updateTaskState(task, state, message, extra = {}) {
    if (setTaskState) {
      setTaskState(task, state, message, extra);
      return;
    }
    task.state = state;
    task.message = message || task.message;
    task.updatedAt = new Date().toISOString();
    Object.assign(task, extra);
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

  function materializeCachedToolResult(cacheHit, toolName, args) {
    if (cacheHit.cacheKind === 'covered_range' && toolName === 'excel_read_rows' && cacheHit.rawResult?.data) {
      const startRow = Number(args.startRow);
      const endRow = Number(args.endRow);
      const source = cacheHit.rawResult.data;
      const rows = (source.rows || []).filter((row) => Number(row.rowNumber) >= startRow && Number(row.rowNumber) <= endRow);
      const sliced = {
        ...source,
        startRow,
        endRow,
        rows,
      };
      const modelContent = compactToolContentForModel({ data: sliced }, toolName);
      const resultSummary = summarizeToolResult({ data: sliced });
      return { modelContent, resultSummary };
    }
    return {
      modelContent: cacheHit.modelContent,
      resultSummary: cacheHit.resultSummary,
    };
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

  function rowValues(rawRows, rowNumber) {
    return (rawRows || []).find((row) => Number(row.rowNumber) === Number(rowNumber))?.values || [];
  }

  function looksNumeric(value) {
    return /^-?\d+(?:,\d{3})*(?:\.\d+)?$/.test(String(value || '').trim());
  }

  function inferSimpleAggregationPlan(task) {
    const metadata = task.metadata || {};
    const requirement = String(task.requirement || '');
    if (!/用量|数量|次数|金额|合计|总计|总和|求和|一共|所有|多少|sum|total/i.test(requirement)) return null;
    const asksWholeTable = /所有|全部|整体|总计|合计|总和|求和|一共|总共|total|sum/i.test(requirement);
    const hasScopedCondition = /\d{4}[-年/]|[一二三四五六七八九十\d]{1,2}月|到|至|之间|按|每|分类|筛选|大于|小于|等于|包含|where|group/i.test(requirement);
    if (!asksWholeTable && hasScopedCondition) return null;
    const operation = /平均|均值|avg|average/i.test(requirement)
      ? 'avg'
      : /最大|max/i.test(requirement)
        ? 'max'
        : /最小|min/i.test(requirement)
          ? 'min'
          : 'sum';
    const rawRows = Array.isArray(metadata.rawRows) ? metadata.rawRows : [];
    const headerRowNumber = Number(metadata.detectedHeaderRowNumber || 0);
    const headerValues = rowValues(rawRows, headerRowNumber).map((value) => String(value || '').trim());
    const dataRow = rawRows.find((row) => Number(row.rowNumber) > headerRowNumber && (row.values || []).some((value) => String(value || '').trim()));
    if (!headerRowNumber || !headerValues.some(Boolean) || !dataRow) return null;

    const metricKeywords = ['用量', '数量', '次数', '金额', '收入', '支出', '余额'];
    const timeKeywords = ['时间', '日期', 'date', 'time'];
    let bestMetric = null;
    for (const [index, name] of headerValues.entries()) {
      if (!name) continue;
      const sampleValue = dataRow.values?.[index] || '';
      const isTime = timeKeywords.some((keyword) => name.toLowerCase().includes(keyword.toLowerCase()));
      let score = 0;
      if (requirement.includes(name)) score += 12;
      if (metricKeywords.some((keyword) => name.includes(keyword))) score += 8;
      if (looksNumeric(sampleValue)) score += 4;
      if (isTime) score -= 10;
      if (!bestMetric || score > bestMetric.score) {
        bestMetric = { index, name, score, sampleValue };
      }
    }
    if (!bestMetric || bestMetric.score < 8) return null;
    const firstDataRowNumber = Number(dataRow.rowNumber);
    const sheetName = metadata.sheetName || (metadata.sheetNames || [])[0] || '';
    const operationText = { sum: '求和', avg: '求平均值', max: '取最大值', min: '取最小值' }[operation] || '聚合';
    return {
      status: 'ready',
      confidence: 0.9,
      evidence: [
        {
          tool: 'metadata_preview',
          finding: `预览行已覆盖真实表头第 ${headerRowNumber} 行，识别到列：${headerValues.filter(Boolean).join('、')}；第 ${firstDataRowNumber} 行已出现数据样例。`,
          rows: [headerRowNumber, firstDataRowNumber],
        },
      ],
      needed_columns: [bestMetric.name],
      implementation_plan: [
        `直接读取工作表 ${sheetName || '默认工作表'}。`,
        `使用第 ${headerRowNumber} 行作为表头，pandas 读取时设置 skiprows=${headerRowNumber - 1}。`,
        `对 ${bestMetric.name} 列执行 ${operationText}，由本地 Python 脚本处理全表数据，不在模型探索阶段扫描整表。`,
      ].join(' '),
      questions: [],
      fastPath: 'metadata_preview_simple_aggregation',
      aggregation: {
        sheetName,
        column: bestMetric.name,
        operation,
        headerRowNumber,
        firstDataRowNumber,
      },
    };
  }

  function parseDateRange(text) {
    const normalized = String(text || '').replace(/\//g, '-').replace(/年|月/g, '-').replace(/日/g, '');
    const matches = [...normalized.matchAll(/\d{4}-\d{1,2}-\d{1,2}/g)].map((match) => match[0]);
    if (matches.length < 2) return null;
    return { startDate: matches[0], endDate: matches[1] };
  }

  function trimReplacementText(value) {
    return String(value || '')
      .replace(/^[\s，。；,：:]+|[\s，。；,：:]+$/g, '')
      .replace(/\s*(?:格式保持一致|保持原格式|保持格式一致|保持一致|原格式|原表|不改变格式|不改变原格式).*$/g, '')
      .trim();
  }

  function extractReplacementPair(requirement) {
    const text = String(requirement || '');
    const quoted = [...text.matchAll(/[“"‘'`](.+?)[”"’'`]/g)]
      .map((match) => trimReplacementText(match[1]))
      .filter(Boolean);
    if (quoted.length >= 2) {
      return { oldValue: quoted[0], newValue: quoted[1] };
    }
    const compact = text.replace(/[，。；,]/g, ' ');
    const match = /(?:请)?(?:把|将)?\s*(.+?)\s*(?:改成|修改为|替换为|变成|设为|置为|填为)\s*(.+)$/i.exec(compact);
    if (!match) return null;
    const oldValue = trimReplacementText(match[1]);
    const newValue = trimReplacementText(match[2]);
    if (!oldValue || !newValue) return null;
    if (oldValue.length < 2 || newValue.length < 2) return null;
    return { oldValue, newValue };
  }

  function inferTextReplacePatchPlan(task) {
    const metadata = task.metadata || {};
    if (metadata.fileKind !== 'xlsx') return null;
    const requirement = String(task.requirement || '');
    if (!/改成|修改为|设为|置为|变成|替换为|填为/.test(requirement)) return null;
    if (/生成|输出|汇总|统计|合计|透视|分类|分组|新增|创建|制作|编制/.test(requirement)) return null;
    const replacement = extractReplacementPair(requirement);
    if (!replacement) return null;
    const patch = {
      mode: 'text_replace',
      oldValue: replacement.oldValue,
      newValue: replacement.newValue,
    };
    const evidenceRows = Number(metadata.detectedHeaderRowNumber || 0) ? [Number(metadata.detectedHeaderRowNumber || 0)] : [];
    return {
      status: 'ready',
      confidence: 0.97,
      evidence: [
        {
          tool: 'metadata_preview',
          finding: `识别为原位文本替换任务：将“${replacement.oldValue}”替换为“${replacement.newValue}”，需要保留原工作簿格式。`,
          rows: evidenceRows,
        },
      ],
      needed_columns: [],
      implementation_plan: `复制原工作簿并直接替换所有精确匹配“${replacement.oldValue}”的单元格为“${replacement.newValue}”，不重建工作簿。`,
      questions: [],
      executionMode: 'workbook_patch',
      workbookPatch: patch,
    };
  }

  function inferDateRangePatchPlan(task) {
    const metadata = task.metadata || {};
    if (metadata.fileKind !== 'xlsx') return null;
    const requirement = String(task.requirement || '');
    if (!/改成|修改为|设为|置为|清零|变成|替换为|填为/.test(requirement)) return null;
    const dateRange = parseDateRange(requirement);
    if (!dateRange) return null;
    const rawRows = Array.isArray(metadata.rawRows) ? metadata.rawRows : [];
    const headerRowNumber = Number(metadata.detectedHeaderRowNumber || 0);
    const headerValues = rowValues(rawRows, headerRowNumber).map((value) => String(value || '').trim());
    if (!headerRowNumber || !headerValues.some(Boolean)) return null;
    const conditionColumn = headerValues.find((name) => /日期|时间|date|time/i.test(name));
    const targetColumn = headerValues.find((name) => name && requirement.includes(name) && name !== conditionColumn)
      || headerValues.find((name) => /用量|数量|次数|金额|收入|支出|余额/i.test(name));
    if (!conditionColumn || !targetColumn) return null;
    const valueMatch = /(?:改成|修改为|设为|置为|变成|替换为|填为)\s*([-+]?\d+(?:\.\d+)?|[^，。；\s]+)/.exec(requirement);
    const newValue = /清零/.test(requirement) ? '0' : (valueMatch ? valueMatch[1] : null);
    if (newValue === null || newValue === undefined || newValue === '') return null;
    const sheetName = metadata.sheetName || (metadata.sheetNames || [])[0] || '';
    return {
      status: 'ready',
      confidence: 0.9,
      evidence: [
        {
          tool: 'metadata_preview',
          finding: `识别为格式保留型修改任务：按 ${conditionColumn} 在 ${dateRange.startDate} 到 ${dateRange.endDate} 的范围内修改 ${targetColumn}。`,
          rows: [headerRowNumber],
        },
      ],
      needed_columns: [conditionColumn, targetColumn],
      implementation_plan: `复制原工作簿并直接修改单元格：使用第 ${headerRowNumber} 行作为表头，将 ${conditionColumn} 在 ${dateRange.startDate} 到 ${dateRange.endDate} 范围内的 ${targetColumn} 改为 ${newValue}。`,
      questions: [],
      executionMode: 'workbook_patch',
      workbookPatch: {
        mode: 'date_range_set',
        sheetName,
        headerRowNumber,
        conditionColumn,
        targetColumn,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        newValue,
      },
    };
  }

  function inferWorkbookPatchPlan(task) {
    return inferTextReplacePatchPlan(task) || inferDateRangePatchPlan(task) || null;
  }

  function isCoreAggregateResult(task, toolName, args, toolContent) {
    if (toolName !== 'excel_aggregate') return false;
    const rows = Array.isArray(toolContent?.rows) ? toolContent.rows : [];
    if (!rows.length || rows[0]?.value === null || rows[0]?.value === undefined) return false;
    const requirement = String(task.requirement || '');
    const operation = args.operation || 'sum';
    if (operation === 'sum' && /用量|数量|次数|金额|合计|总计|总和|求和|一共|所有|多少/i.test(requirement)) return true;
    if (operation === 'avg' && /平均|均值/i.test(requirement)) return true;
    if (operation === 'max' && /最大|最高/i.test(requirement)) return true;
    if (operation === 'min' && /最小|最低/i.test(requirement)) return true;
    return false;
  }

  function compactAgentToolTraceForCode(trace = []) {
    const kept = [];
    const seen = new Set();
    for (const item of trace) {
      const result = item.result || {};
      const cacheHit = Boolean(result.cacheHit);
      const lowValueRead = item.toolName === 'excel_read_rows' && cacheHit;
      if (lowValueRead) continue;
      const key = `${item.toolName}:${stableStringify(item.args || {})}:${JSON.stringify(result).slice(0, 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(item);
    }
    return kept.slice(-8);
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
    if (/\bdef\s+classify\w*\s*\(/i.test(code)) {
      failures.push('禁止在 Python 中编写业务分类函数，请使用语义映射表贴标');
    }
    if (/\.str\.contains\s*\(/.test(code) && /(分类|类别|标签|现金流|情感|归类|判定|活动)/.test(code)) {
      failures.push('禁止用 str.contains/正则对非结构化文本做业务归类');
    }
    if (/\bre\.(?:search|match|findall|sub)\s*\(/.test(code) && /(分类|类别|标签|现金流|情感|归类|判定|活动)/.test(code)) {
      failures.push('禁止用正则对非结构化文本做业务归类');
    }
    const readsMultiIndexHeader = /read_excel\s*\([\s\S]*?header\s*=\s*\[[^\]]+\]/m.test(code);
    const writesWithoutIndex = /\.to_excel\s*\([\s\S]*?index\s*=\s*False/m.test(code);
    const createsMultiIndexColumns = /\b(?:pd\.)?MultiIndex\b|\.from_tuples\s*\(|\.from_product\s*\(/m.test(code);
    const flattensColumns = /to_flat_index\s*\(|\.columns\s*=\s*(?!pd\.MultiIndex\b)/m.test(code);
    if ((readsMultiIndexHeader || createsMultiIndexColumns) && writesWithoutIndex && !flattensColumns) {
      failures.push('读取或创建多级列头后，禁止直接 to_excel(index=False)；必须先把所有输出 DataFrame 的 columns 扁平化为一维唯一字符串');
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

  function withToolReasonParameters(parameters) {
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    return {
      ...parameters,
      properties: {
        reason: {
          type: 'string',
          description: '必填。用第一人称简短说明为什么本次需要调用这个工具，例如“我需要调用这个工具来确认相关工作表和表头结构”。',
        },
        ...(parameters.properties || {}),
      },
      required: Array.from(new Set(['reason', ...required])),
      additionalProperties: false,
    };
  }

  function traceToolReason(toolName, args = {}) {
    const reason = String(args.reason || '').replace(/\s+/g, ' ').trim();
    if (reason) {
      return reason.length > 160 ? `${reason.slice(0, 160)}...` : reason;
    }
    return `我需要调用 ${toolName} 来继续探索表格数据。`;
  }

  function stripToolTraceOnlyArgs(args = {}) {
    const { reason, ...toolArgs } = args;
    return toolArgs;
  }

  const EXCEL_AGENT_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'excel_list_sheets',
        description: '列出当前工作簿的工作表、行数、列数和表头候选。先调用这个工具了解全局结构。',
        parameters: withToolReasonParameters({ type: 'object', properties: {}, additionalProperties: false }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_get_schema',
        description: '读取指定工作表的列结构、表头候选和前 20 行样本。用于确认列名、列号和表头行。',
        parameters: withToolReasonParameters({
          type: 'object',
          properties: {
            sheetName: {
              type: 'string',
              description: '可选。指定工作表名称；省略时使用默认工作表。',
            },
          },
          additionalProperties: false,
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_read_rows',
        description: '读取当前任务表格中指定工作表的连续行。行号为 Excel 语义的 1-based 闭区间，单次最多 200 行。',
        parameters: withToolReasonParameters({
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
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_sample_rows',
        description: '读取指定工作表的样本行，支持 first、last、around、random。用于快速观察大表局部结构。',
        parameters: withToolReasonParameters({
          type: 'object',
          properties: {
            sheetName: { type: 'string', description: '可选。工作表名称。' },
            mode: { type: 'string', enum: ['first', 'last', 'around', 'random'], description: '采样方式，默认 first。' },
            rowNumber: { type: 'integer', minimum: 1, description: 'mode=around 时的中心行号。' },
            count: { type: 'integer', minimum: 1, maximum: 200, description: '最多读取多少行，默认 20。' },
          },
          additionalProperties: false,
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_search',
        description: '在索引中做大小写不敏感的文本包含搜索，返回 sheet、1-based 行号、列号、列名和值。',
        parameters: withToolReasonParameters({
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的文本关键词，不能为空。' },
            sheetName: { type: 'string', description: '可选。指定工作表；省略时搜索整个工作簿。' },
            maxResults: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条命中，默认 20，最大 50。' },
          },
          required: ['query'],
          additionalProperties: false,
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_filter_rows',
        description: '按列过滤行，适合定位大表中的候选记录。column 可用列名、列号或 c1/c2。',
        parameters: withToolReasonParameters({
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
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_aggregate',
        description: '对指定列做 sum/avg/min/max/count，可选按另一列分组。适合先验证金额、数量、分类汇总。',
        parameters: withToolReasonParameters({
          type: 'object',
          properties: {
            sheetName: { type: 'string', description: '可选。工作表名称。' },
            column: { type: 'string', description: '要聚合的列名、列号或 cN。' },
            operation: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'], description: '聚合操作，默认 sum。' },
            groupBy: { type: 'string', description: '可选。分组列名、列号或 cN。' },
          },
          required: ['column'],
          additionalProperties: false,
        }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'excel_profile_column',
        description: '查看指定列的非空数量、去重数量、数值范围和高频值，帮助判断列语义。',
        parameters: withToolReasonParameters({
          type: 'object',
          properties: {
            sheetName: { type: 'string', description: '可选。工作表名称。' },
            column: { type: 'string', description: '列名、1-based 列号或 cN。' },
          },
          required: ['column'],
          additionalProperties: false,
        }),
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

  function extractJsonArray(text) {
    if (!text) return [];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const source = fenced ? fenced[1] : text;
    const start = source.indexOf('[');
    const end = source.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
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

  async function ensureWorkbookIndexReady(task) {
    if (task.indexStatus === 'ready' && task.workbookProfile) return;
    const indexDir = task.indexDir || path.join(task.dir, 'index');
    const manifestPath = path.join(indexDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.version === WORKBOOK_INDEX_VERSION) {
        task.workbookProfile = manifest;
        task.indexStatus = 'ready';
        task.indexReused = true;
        publish(task, 'index_ready', {
          message: '复用已有 DuckDB 表格索引',
          profile: summarizeToolResult({ sheets: manifest.sheets || [] }),
          task: publicTask(task),
        });
        return;
      }
    }
    task.indexStatus = 'indexing';
    publish(task, 'indexing', { message: '正在为对话澄清构建只读表格索引', task: publicTask(task) });
    const indexed = await buildWorkbookIndex(task);
    task.indexDir = indexed.indexDir;
    task.workbookProfile = indexed.manifest;
    task.indexStatus = 'ready';
    task.indexReused = false;
    publish(task, 'index_ready', {
      message: '对话澄清可用的表格索引构建完成',
      profile: summarizeToolResult({ sheets: indexed.manifest.sheets || [] }),
      task: publicTask(task),
    });
  }

  function normalizeDraftResponse(parsed, fallbackReply) {
    const response = parsed && typeof parsed === 'object' ? parsed : {};
    const executionSpec = response.executionSpec && typeof response.executionSpec === 'object'
      ? response.executionSpec
      : {};
    const finalRequirement = String(
      executionSpec.finalRequirement
        || response.finalRequirement
        || response.requirement
        || '',
    ).trim();
    return {
      reply: String(response.reply || fallbackReply || '').trim()
        || '我还需要你补充目标结果、筛选条件或输出格式后才能开始执行。',
      ready: Boolean(response.ready && finalRequirement),
      openQuestions: Array.isArray(response.openQuestions)
        ? response.openQuestions.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      assumptions: Array.isArray(response.assumptions)
        ? response.assumptions.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      executionSpec: {
        ...executionSpec,
        finalRequirement,
      },
    };
  }

  function buildDraftModelMessages(task) {
    const systemPrompt = [
      '你是一个面向普通 C 端用户的 Excel 任务澄清 Agent。',
      '你的目标不是执行任务，而是通过自然对话把模糊需求整理成可执行说明。',
      '你可以少量调用只读 Excel 工具确认工作表、表头、样例行或关键词位置；禁止生成代码，禁止承诺已经完成处理。',
      `本轮对话最多使用 ${DRAFT_TOOL_CALL_LIMIT} 次只读工具；如果仅凭元数据已经能提问，就不要调用工具。`,
      '当需求仍不明确时，提出 1 到 3 个最关键的问题，不要一次问太多。',
      '当需求已经足够执行时，给出简短确认说明，并把 ready 设为 true。',
      '整个回复必须只输出 JSON 对象，不要 Markdown。',
      'JSON 格式：{"reply":"给用户看的自然语言回复","ready":true|false,"openQuestions":["待用户回答的问题"],"assumptions":["默认假设"],"executionSpec":{"finalRequirement":"确认后的完整执行需求","targetSheets":["工作表"],"requiredColumns":["列名"],"outputSheets":["输出表"],"rules":["业务规则"],"assumptions":["执行假设"]}}',
    ].join('\n');
    const context = [
      '【文件信息】',
      JSON.stringify({
        filename: task.filename,
        metadata: task.metadata,
        workbookProfile: task.workbookProfile
          ? { sheets: (task.workbookProfile.sheets || []).map((sheet) => ({
            sheetName: sheet.sheetName,
            totalRows: sheet.totalRows,
            totalColumns: sheet.totalColumns,
            detectedHeaderRowNumber: sheet.detectedHeaderRowNumber,
          })) }
          : null,
      }),
      '',
      '【长期规则命中】',
      JSON.stringify(task.retrievedRules || []),
      '',
      '【本次特例规则】',
      task.temporaryRules || '无',
      '',
      '【当前执行说明草稿】',
      JSON.stringify(task.executionSpec || {}),
    ].join('\n');
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      ...(task.chatMessages || []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
      })),
    ];
  }

  async function refineTaskDraft(task) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('缺少 OPENAI_API_KEY，无法进行对话式需求澄清');
    }
    assertTaskNotCancelled(task);
    if (!task.metadata) throw new Error('文件元数据尚未解析完成，请稍后再发消息');
    if (!task.retrievedRules || !task.retrievedRules.length) task.retrievedRules = [];
    if (!Array.isArray(task.draftTrace)) task.draftTrace = [];
    const model = process.env.OPENAI_MODEL || 'gpt-4o';
    const messages = buildDraftModelMessages(task);
    let toolCallCount = 0;
    for (let round = 0; round <= DRAFT_TOOL_ROUND_LIMIT; round += 1) {
      assertTaskNotCancelled(task);
      const message = await callOpenAiCompatible(messages, 0, {
        taskId: task.id,
        phase: 'draft_chat',
        round,
      }, {
        stream: false,
        tools: EXCEL_AGENT_TOOLS,
        toolChoice: 'auto',
        returnMessage: true,
      });
      if (!message) throw new Error('模型未返回对话澄清结果');
      let toolCalls = message.tool_calls || [];
      if (!toolCalls.length) {
        toolCalls = parseDsmlToolCalls(message.content || '');
        if (toolCalls.length) {
          message.tool_calls = toolCalls;
          message.content = '';
        }
      }
      if (!toolCalls.length) {
        const parsed = extractJsonObject(message.content || '');
        const draft = normalizeDraftResponse(parsed, message.content || '');
        task.executionSpec = draft.executionSpec;
        task.draftReady = draft.ready;
        task.questions = draft.openQuestions;
        task.chatMessages.push({
          role: 'assistant',
          content: draft.reply,
          at: new Date().toISOString(),
          ready: draft.ready,
          openQuestions: draft.openQuestions,
          executionSpec: draft.executionSpec,
          assumptions: draft.assumptions,
        });
        updateTaskState(task, draft.ready ? 'ready_to_execute' : 'drafting', draft.ready ? '需求已确认，可开始执行' : '等待继续补充需求', {
          questions: draft.openQuestions,
        });
        publish(task, 'draft_message', {
          message: draft.reply,
          ready: draft.ready,
          openQuestions: draft.openQuestions,
          executionSpec: draft.executionSpec,
          task: publicTask(task),
        });
        return draft;
      }

      messages.push(toAssistantHistoryMessage(message, model));
      await ensureWorkbookIndexReady(task);
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function?.name || '';
        let rawArgs = {};
        let args = {};
        let reason = traceToolReason(toolName, {});
        let toolContent;
        const traceItem = { toolName, reason, args: {}, at: new Date().toISOString() };
        try {
          rawArgs = parseToolArguments(toolCall.function?.arguments || '{}');
          args = stripToolTraceOnlyArgs(rawArgs);
          reason = traceToolReason(toolName, rawArgs);
          traceItem.reason = reason;
          traceItem.args = summarizeToolArgs(args);
          task.draftTrace.push(traceItem);
          publish(task, 'draft_tool_call', {
            message: `对话澄清调用 ${toolName}：${reason}`,
            toolName,
            reason,
            args: traceItem.args,
            task: publicTask(task),
          });
          if (toolCallCount >= DRAFT_TOOL_CALL_LIMIT) {
            toolContent = budgetSkippedToolContent(toolName, '对话澄清阶段的只读工具预算已用完', 0);
            traceItem.result = summarizeToolResult(toolContent);
            publish(task, 'draft_tool_result', {
              message: `${toolName} 已跳过：对话澄清工具预算已用完`,
              toolName,
              result: traceItem.result,
              task: publicTask(task),
            });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: JSON.stringify(toolContent),
            });
            continue;
          }
          toolCallCount += 1;
          const result = await runExcelTool(task, toolName, args);
          const resultSummary = summarizeToolResult(result);
          toolContent = compactToolContentForModel(result, toolName);
          traceItem.result = resultSummary;
          publish(task, 'draft_tool_result', {
            message: `${toolName} 已返回对话澄清摘要`,
            toolName,
            result: resultSummary,
            task: publicTask(task),
          });
        } catch (error) {
          toolContent = toolErrorData(error, toolName);
          traceItem.result = summarizeToolResult(toolContent);
          if (!task.draftTrace.includes(traceItem)) task.draftTrace.push(traceItem);
          publish(task, 'draft_tool_result', {
            message: `${toolName} 对话澄清调用失败：${toolContent.error}`,
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
      if (toolCallCount >= DRAFT_TOOL_CALL_LIMIT) {
        messages.push({
          role: 'user',
          content: '对话澄清阶段的只读工具预算已经用完。请基于已有信息输出规定 JSON；如果仍不确定，请提出最关键问题。',
        });
      }
    }
    throw new Error('模型未能在对话澄清轮次内输出合法需求草稿');
  }

  function applyAgentPlan(task, plan) {
    const normalizedPlan = { ...plan };
    if (normalizedPlan.workbookPatch) {
      normalizedPlan.workbookPatch = {
        ...normalizedPlan.workbookPatch,
        mode: normalizedPlan.workbookPatch.mode
          || (normalizedPlan.workbookPatch.startDate && normalizedPlan.workbookPatch.endDate ? 'date_range_set' : 'text_replace'),
      };
      normalizedPlan.executionMode = normalizedPlan.executionMode || 'workbook_patch';
    }
    task.agentPlan = normalizedPlan;
    task.agentExplorationSummary = normalizedPlan.implementation_plan || JSON.stringify(normalizedPlan);
    task.explorationCheckpoint = null;
    publish(task, 'agent_summary', {
      message: task.agentExplorationSummary || '数据探索完成',
      plan: normalizedPlan,
      task: publicTask(task),
    });
    if (normalizedPlan.status === 'needs_clarification' && Array.isArray(normalizedPlan.questions) && normalizedPlan.questions.length) {
      task.questions = normalizedPlan.questions;
    }
    return task.agentExplorationSummary;
  }

  function tryPlanFromMetadata(task) {
    if (task.agentPlan?.status === 'ready') return true;
    if (!task.explorationCheckpoint) task.agentTrace = [];
    const patchPlan = inferWorkbookPatchPlan(task);
    if (patchPlan) {
      applyAgentPlan(task, patchPlan);
      return true;
    }
    const fastPlan = inferSimpleAggregationPlan(task);
    if (fastPlan) {
      applyAgentPlan(task, fastPlan);
      return true;
    }
    return false;
  }

  function totalRowsFromTask(task) {
    const metadataRows = Number(task.metadata?.totalRows || 0);
    const indexedRows = (task.workbookProfile?.sheets || []).reduce(
      (sum, sheet) => sum + Number(sheet.totalRows || 0),
      0,
    );
    return Math.max(metadataRows, indexedRows);
  }

  function budgetExtensionReason(task, extensionCount) {
    if (extensionCount >= AGENT_TOOL_BUDGET_EXTENSION_LIMIT) return '';
    if (AGENT_TOOL_BUDGET_EXTENSION_CALLS <= 0) return '';
    const requirement = String(task.requirement || '');
    const sheets = task.workbookProfile?.sheets || [];
    const totalRows = totalRowsFromTask(task);
    const totalColumns = Math.max(
      Number(task.metadata?.totalColumns || 0),
      ...sheets.map((sheet) => Number(sheet.totalColumns || 0)),
    );
    const trace = task.agentTrace || [];
    const hasToolError = trace.some((item) => item.result?.ok === false || item.result?.error);
    if (/现金流量表|现金流|序时账|经营活动|投资活动|筹资活动|勾稽/.test(requirement)) {
      return '需求涉及现金流量表或序时账，需要额外预算补足分类依据、异常样本或勾稽验证。';
    }
    if (sheets.length > 1) {
      return `工作簿包含 ${sheets.length} 个工作表，需要额外预算确认相关表和字段。`;
    }
    if (totalRows >= 10000 || totalColumns >= 30) {
      return `表格规模较大（约 ${totalRows || '未知'} 行、${totalColumns || '未知'} 列），需要额外预算完成结构确认和关键聚合。`;
    }
    if (hasToolError) {
      return '已有可恢复工具调用失败消耗预算，需要额外预算调整参数补足证据。';
    }
    return '';
  }

  function extendToolBudgetIfJustified(task, budgetState, messages, round, trigger, options = {}) {
    const reason = budgetExtensionReason(task, budgetState.extensionCount);
    if (!reason) return false;
    budgetState.extensionCount += 1;
    budgetState.activeLimit += AGENT_TOOL_BUDGET_EXTENSION_CALLS;
    const message = [
      `工具预算扩展 ${budgetState.extensionCount}/${AGENT_TOOL_BUDGET_EXTENSION_LIMIT}：${reason}`,
      `触发原因：${trigger}`,
      `新的工具预算上限为 ${budgetState.activeLimit} 次。`,
    ].join('\n');
    log('info', 'agent_tool_budget_extended', {
      taskId: task.id,
      round,
      reason,
      trigger,
      extensionCount: budgetState.extensionCount,
      addedCalls: AGENT_TOOL_BUDGET_EXTENSION_CALLS,
      activeLimit: budgetState.activeLimit,
    });
    publish(task, 'tool_budget_extended', {
      message,
      reason,
      trigger,
      extensionCount: budgetState.extensionCount,
      addedCalls: AGENT_TOOL_BUDGET_EXTENSION_CALLS,
      activeLimit: budgetState.activeLimit,
      task: publicTask(task),
    });
    const modelNotice = [
      message,
      '额外预算只能用于补足关键证据、确认字段/分类或验证结果；禁止重复调用已缓存参数，信息足够时立即输出规定 JSON。',
    ].join('\n');
    if (options.appendMessage === false) {
      budgetState.pendingNotice = modelNotice;
    } else {
      messages.push({
        role: 'user',
        content: modelNotice,
      });
    }
    return true;
  }

  async function requestFinalExplorationJson(task, messages, model, round, reason, budgetLimit = AGENT_TOOL_CALL_LIMIT) {
    messages.push({
      role: 'user',
      content: [
        reason,
        `当前 Excel 工具预算上限为 ${budgetLimit} 次，已进入收敛阶段。`,
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
    if (tryPlanFromMetadata(task)) return task.agentExplorationSummary;
    const systemPrompt = [
      '你是一个 Excel 数据探索 Agent。',
      '你必须通过提供的索引工具按需查询当前上传表格，不能假设没有查询过的数据。',
      '工具行号均为 Excel 语义的 1-based 行号；列可以用列名、列号或 c1/c2。',
      `基础工具预算最多 ${AGENT_TOOL_CALL_LIMIT} 次；每轮最多请求 ${AGENT_TOOL_CALLS_PER_ROUND} 个工具。`,
      `复杂任务接近预算上限时，系统最多可扩展 ${AGENT_TOOL_BUDGET_EXTENSION_LIMIT} 轮，每轮增加 ${AGENT_TOOL_BUDGET_EXTENSION_CALLS} 次，但必须由系统记录明确理由。`,
      '先调用 excel_list_sheets 判断相关工作表，只对最相关工作表调用 excel_get_schema，不要一次性扫描所有 sheet schema。',
      '用 search/filter/aggregate/profile 定位证据；只有需要确认表头或样本时才读取少量行。',
      '不要请求读取整个文件；需要大范围分析时使用 filter、aggregate 或 profile。',
      '不要重复请求相同工具参数；不要用 random 采样代替明确证据。',
      '每次调用工具时，必须填写 reason 参数，用第一人称简短说明“我需要调用某某工具来做什么”。',
      '当剩余预算不足或信息足够时，立即停止调用工具，并只输出规定 JSON 对象。',
      '当信息足够时，停止调用工具，并只输出一个 JSON 对象，不要输出 Markdown。',
      'JSON 格式：{"status":"ready|needs_clarification","confidence":0-1,"evidence":[{"tool":"工具名","finding":"发现","rows":[行号]}],"needed_columns":["列名"],"implementation_plan":"后续代码生成依据","questions":["需要用户补充的问题"]}',
    ].join('\n');
    const initialMessages = [
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

    const previousCheckpoint = task.explorationCheckpoint?.phase === 'explore_data'
      ? task.explorationCheckpoint
      : null;
    const messages = previousCheckpoint?.messages || initialMessages;
    const toolCache = previousCheckpoint?.toolCache instanceof Map ? previousCheckpoint.toolCache : new Map();
    let toolCallCount = Number(previousCheckpoint?.toolCallCount || 0);
    const budgetState = previousCheckpoint?.budgetState || {
      activeLimit: AGENT_TOOL_CALL_LIMIT,
      extensionCount: 0,
      pendingNotice: '',
    };
    const startRound = Number(previousCheckpoint?.nextRound || 0);
    if (previousCheckpoint) {
      publish(task, 'resume', {
        message: `复用工具探索进度，从第 ${startRound + 1} 轮继续`,
        round: startRound,
        toolCallCount,
        task: publicTask(task),
      });
    }
    const maxRounds = AGENT_TOOL_CALL_LIMIT
      + (AGENT_TOOL_BUDGET_EXTENSION_CALLS * AGENT_TOOL_BUDGET_EXTENSION_LIMIT)
      + 1;
    for (let round = startRound; round <= maxRounds; round += 1) {
      assertTaskNotCancelled(task);
      task.explorationCheckpoint = {
        phase: 'explore_data',
        messages,
        toolCache,
        toolCallCount,
        budgetState,
        nextRound: round,
      };
      if (toolCallCount >= budgetState.activeLimit - AGENT_FORCE_FINAL_REMAINING) {
        const extended = extendToolBudgetIfJustified(task, budgetState, messages, round, '工具预算即将耗尽');
        if (!extended) {
          return requestFinalExplorationJson(task, messages, model, round, '工具预算即将耗尽。', budgetState.activeLimit);
        }
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
        let rawArgs = {};
        let argumentError = null;
        try {
          rawArgs = parseToolArguments(toolCall.function?.arguments || '{}');
        } catch (error) {
          argumentError = error;
        }
        const toolName = toolCall.function?.name || '';
        const args = argumentError ? {} : stripToolTraceOnlyArgs(rawArgs);
        const reason = argumentError ? traceToolReason(toolName, {}) : traceToolReason(toolName, rawArgs);
        const cacheHit = argumentError ? null : findCachedToolResult(toolCache, toolName, args);
        return { toolCall, index, toolName, args, reason, argumentError, cacheHit };
      });
      const executableToolCalls = parsedToolCalls.filter((item) => !item.argumentError && !item.cacheHit);
      const requestedThisRound = Math.min(executableToolCalls.length, AGENT_TOOL_CALLS_PER_ROUND);
      let remainingBeforeRound = budgetState.activeLimit - toolCallCount;
      if (requestedThisRound > remainingBeforeRound) {
        const extended = extendToolBudgetIfJustified(
          task,
          budgetState,
          messages,
          round,
          '本轮请求的工具数量超过剩余预算',
          { appendMessage: false },
        );
        if (extended) {
          remainingBeforeRound = budgetState.activeLimit - toolCallCount;
        }
      }
      const selectedIndexes = new Set(
        executableToolCalls
          .sort((left, right) => {
            const priorityDelta = toolPriority(right.toolName, right.args) - toolPriority(left.toolName, left.args);
            return priorityDelta || left.index - right.index;
          })
          .slice(0, Math.max(0, Math.min(remainingBeforeRound, AGENT_TOOL_CALLS_PER_ROUND)))
          .map((item) => item.index),
      );

      let forceFinalReason = '';
      for (const item of parsedToolCalls) {
        assertTaskNotCancelled(task);
        const { toolCall, toolName, args, reason, argumentError, cacheHit } = item;
        const traceItem = {
          toolName,
          reason,
          args: argumentError ? { invalidArguments: true } : summarizeToolArgs(args),
          at: new Date().toISOString(),
        };
        task.agentTrace.push(traceItem);
        publish(task, 'tool_call', {
          message: `调用 ${toolName}：${reason}`,
          toolName,
          reason,
          args: traceItem.args,
          task: publicTask(task),
        });

        let toolContent;
        try {
          if (argumentError) throw argumentError;
          if (cacheHit) {
            const cached = materializeCachedToolResult(cacheHit, toolName, args);
            toolContent = { ...cached.modelContent, cacheHit: true, cacheKind: cacheHit.cacheKind };
            traceItem.result = { ...cached.resultSummary, cacheHit: cacheHit.cacheKind };
            publish(task, 'tool_result', {
              message: `${toolName} 复用缓存摘要`,
              toolName,
              result: traceItem.result,
              task: publicTask(task),
            });
          } else if (!selectedIndexes.has(item.index)) {
            const remainingBudget = budgetState.activeLimit - toolCallCount;
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
            if (isCoreAggregateResult(task, toolName, args, modelContent)) {
              forceFinalReason = `${toolName} 已得到足以回答用户需求的核心聚合结果。`;
            }
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
              rawResult: result,
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
      if (budgetState.pendingNotice) {
        messages.push({
          role: 'user',
          content: budgetState.pendingNotice,
        });
        budgetState.pendingNotice = '';
      }
      if (forceFinalReason) {
        return requestFinalExplorationJson(task, messages, model, round + 1, forceFinalReason, budgetState.activeLimit);
      }
      if (toolCallCount >= budgetState.activeLimit - AGENT_FORCE_FINAL_REMAINING) {
        const extended = extendToolBudgetIfJustified(task, budgetState, messages, round + 1, '本轮工具执行后预算即将耗尽');
        if (!extended) {
          return requestFinalExplorationJson(task, messages, model, round + 1, '工具预算即将耗尽。', budgetState.activeLimit);
        }
      }
      task.explorationCheckpoint = {
        phase: 'explore_data',
        messages,
        toolCache,
        toolCallCount,
        budgetState,
        nextRound: round + 1,
      };
    }
    return requestFinalExplorationJson(task, messages, model, maxRounds + 1, '已达到探索轮次上限。', budgetState.activeLimit);
  }

  function availableColumnNames(task) {
    const columns = task.metadata?.columns || [];
    return columns.map((column) => column.name).filter(Boolean);
  }

  function pickExistingColumns(names, preferred) {
    return preferred.filter((column) => names.includes(column));
  }

  function stableSemanticDomain(task, proposedDomain) {
    const requirement = String(task.requirement || '');
    const proposed = String(proposedDomain || '').trim().toLowerCase();
    if (/现金流量表|现金流/.test(requirement) || /cash[_\s-]*flow|cashflow|现金/.test(proposed)) return 'cash_flow';
    if (/情感|评价|评论|满意|差评|好评/.test(requirement) || /sentiment/.test(proposed)) return 'sentiment';
    if (/风险|异常|可疑/.test(requirement) || /risk|fraud|异常/.test(proposed)) return 'risk';
    if (/凭证|序时账|科目|财务|审计/.test(requirement) || /finance|audit|ledger|财务|审计/.test(proposed)) return 'finance';
    return 'general';
  }

  function taxonomyVersionFor(domain, taxonomy) {
    if (domain === 'cash_flow') return 'cash-flow-v2';
    if (domain === 'sentiment') return 'sentiment-v1';
    if (domain === 'risk') return 'risk-v1';
    const labels = (Array.isArray(taxonomy) ? taxonomy : [])
      .map((label) => String(label).trim())
      .filter(Boolean);
    if (!labels.length) return 'default-v1';
    return `taxonomy-${crypto.createHash('sha1').update(labels.join('\n')).digest('hex').slice(0, 12)}`;
  }

  function stableSemanticSubjects(task, requestedColumns = []) {
    const names = availableColumnNames(task);
    const requirement = String(task.requirement || '');
    if (/现金流量表|现金流|凭证|序时账|科目/.test(requirement)) {
      const ledgerColumns = pickExistingColumns(names, ['科目编码', '科目', '摘要']);
      if (ledgerColumns.length) return ledgerColumns;
    }
    const preferred = ['摘要', '备注', '评论', '内容', '描述', '科目', '名称', '客户', '供应商', '用途'];
    const matched = names.filter((name) => preferred.some((token) => String(name).includes(token)));
    if (matched.length) return matched.slice(0, 4);
    const requested = (Array.isArray(requestedColumns) ? requestedColumns : [requestedColumns]).filter(Boolean);
    const existingRequested = names.filter((name) => requested.includes(name));
    if (existingRequested.length) return existingRequested.slice(0, 4);
    return names.slice(0, 3);
  }

  function defaultSemanticSubjects(task) {
    return stableSemanticSubjects(task);
  }

  function defaultTaxonomy(requirement) {
    if (/现金流量表|现金流/.test(requirement)) {
      return [
        '销售商品、提供劳务收到的现金',
        '收到的税费返还',
        '收到的其他与经营活动有关的现金',
        '购买商品、接受劳务支付的现金',
        '支付给职工以及为职工支付的现金',
        '支付的各项税费',
        '支付的其他与经营活动有关的现金',
        '收回投资收到的现金',
        '取得投资收益收到的现金',
        '处置固定资产、无形资产和其他长期资产收回的现金净额',
        '处置子公司及其他营业单位收到的现金净额',
        '收到其他与投资活动有关的现金',
        '购建固定资产、无形资产和其他长期资产支付的现金',
        '投资支付的现金',
        '取得子公司及其他营业单位支付的现金净额',
        '支付其他与投资活动有关的现金',
        '吸收投资收到的现金',
        '取得借款收到的现金',
        '收到的其他与筹资活动有关的现金',
        '偿还债务支付的现金',
        '分配股利、利润或偿付利息支付的现金',
        '支付的其他与筹资活动有关的现金',
        '汇率变动对现金及现金等价物的影响',
        '未分类',
      ];
    }
    if (/情感|评价|评论|满意|差评|好评/.test(requirement)) {
      return ['正向', '中性', '负向', '未分类'];
    }
    if (/风险|异常|可疑/.test(requirement)) {
      return ['正常', '异常', '高风险', '需复核'];
    }
    return ['类别A', '类别B', '类别C', '未分类'];
  }

  function heuristicRoute(task) {
    const requirement = String(task.requirement || '');
    const semanticRequired = /分类|归类|标签|打标|识别|判断|情感|评论|摘要|现金流量表|现金流|风险|异常|主观|语义/i.test(requirement);
    const hybrid = /现金流量表|现金流|凭证|序时账|勾稽|对方科目/i.test(requirement);
    const domain = stableSemanticDomain(task, hybrid ? 'cash_flow' : 'general');
    const taxonomy = defaultTaxonomy(requirement);
    return {
      status: 'ready',
      route: {
        task_type: semanticRequired ? (hybrid ? 'hybrid' : 'semantic_mapping') : 'deterministic',
        semantic_required: semanticRequired,
        domain_hint: domain,
        confidence: semanticRequired ? 0.72 : 0.68,
        reason: semanticRequired
          ? '需求包含分类、标签、摘要理解或业务语义判断，不能只依赖代码规则。'
          : '需求看起来主要是结构化计算、筛选或聚合。',
      },
      semanticPlan: semanticRequired ? {
        subject_columns: stableSemanticSubjects(task),
        taxonomy,
        taxonomy_version: taxonomyVersionFor(domain, taxonomy),
        prompt_version: 'semantic-mapping-v1',
      } : null,
    };
  }

  function normalizeRoutePlan(task, rawPlan) {
    const fallback = heuristicRoute(task);
    const route = rawPlan?.route || rawPlan || fallback.route;
    const taskType = String(route.task_type || route.taskType || '').trim() || fallback.route.task_type;
    const semanticRequired = route.semantic_required !== undefined
      ? Boolean(route.semantic_required)
      : ['semantic', 'semantic_mapping', 'hybrid'].includes(taskType);
    const semanticPlan = rawPlan?.semanticPlan || rawPlan?.semantic_plan || fallback.semanticPlan || {};
    const proposedDomain = route.domain_hint || route.domain || fallback.route.domain_hint || 'general';
    const domain = stableSemanticDomain(task, proposedDomain);
    const subjectColumns = semanticPlan.subject_columns || semanticPlan.semantic_subjects || semanticPlan.columns || fallback.semanticPlan?.subject_columns || [];
    const proposedTaxonomy = semanticPlan.taxonomy || semanticPlan.labels || fallback.semanticPlan?.taxonomy || defaultTaxonomy(task.requirement);
    const taxonomy = ['cash_flow', 'sentiment', 'risk'].includes(domain)
      ? defaultTaxonomy(task.requirement)
      : proposedTaxonomy;
    const stableSubjects = stableSemanticSubjects(task, subjectColumns);
    return {
      status: 'ready',
      route: {
        task_type: semanticRequired && taskType === 'semantic' ? 'semantic_mapping' : taskType,
        semantic_required: semanticRequired,
        domain_hint: domain,
        output_shape: route.output_shape || route.outputShape || '',
        confidence: Number(route.confidence || fallback.route.confidence || 0.5),
        reason: route.reason || fallback.route.reason || '',
      },
      semanticPlan: semanticRequired ? {
        subject_columns: stableSubjects,
        taxonomy: (Array.isArray(taxonomy) ? taxonomy : String(taxonomy).split(/[，,、]/)).filter(Boolean).slice(0, 80),
        taxonomy_version: taxonomyVersionFor(domain, Array.isArray(taxonomy) ? taxonomy : String(taxonomy).split(/[，,、]/)),
        prompt_version: 'semantic-mapping-v1',
      } : null,
    };
  }

  async function routeTaskIntent(task) {
    if (task.agentPlan?.route?.task_type) return task.agentPlan;
    const heuristic = heuristicRoute(task);
    if (!process.env.OPENAI_API_KEY) {
      task.agentPlan = { ...(task.agentPlan || {}), ...heuristic };
      return task.agentPlan;
    }
    const prompt = [
      '你是一个表格任务意图路由器，只输出 JSON，不要输出 Markdown。',
      '判断用户需求是否需要非结构化文本语义理解。不要生成代码。',
      '',
      'task_type 只能是 deterministic、semantic_mapping、hybrid：',
      '- deterministic：结构化筛选、计算、聚合、合并、透视即可完成。',
      '- semantic_mapping：需要理解摘要、备注、评论、描述、名称等文本含义并打标签。',
      '- hybrid：先结构化抽取候选，再语义映射，最后确定性汇总。',
      'domain_hint 使用稳定短标识，优先从 cash_flow、sentiment、risk、finance、general 中选择。',
      'subject_columns 只选择真正决定语义归类的列；同一类任务必须保持列集合和顺序稳定。',
      'taxonomy_version 和 prompt_version 使用稳定版本号，不要每次生成新名称。',
      '',
      '输出 JSON 结构：',
      '{"route":{"task_type":"","semantic_required":true,"domain_hint":"","output_shape":"","confidence":0.0,"reason":""},"semanticPlan":{"subject_columns":["列名"],"taxonomy":["标签"],"taxonomy_version":"default-v1","prompt_version":"semantic-mapping-v1"}}',
      '',
      '【用户需求】',
      task.requirement,
      '',
      '【探索结论】',
      task.agentExplorationSummary || '',
      '',
      '【元数据列】',
      JSON.stringify((task.metadata?.columns || []).map((column) => column.name)),
      '',
      '【已有 Agent Plan】',
      JSON.stringify(task.agentPlan || {}),
    ].join('\n');
    const text = await callOpenAiCompatible([
      { role: 'system', content: '你只做任务路由，整个回复必须是 JSON 对象。' },
      { role: 'user', content: prompt },
    ], 0, { taskId: task.id, phase: 'triage' }, { stream: false });
    const parsed = extractJsonObject(text || '') || heuristic;
    const plan = normalizeRoutePlan(task, parsed);
    task.agentPlan = { ...(task.agentPlan || {}), ...plan };
    publish(task, 'agent_summary', {
      message: `意图路由：${plan.route.task_type}`,
      plan: task.agentPlan,
      task: publicTask(task),
    });
    return task.agentPlan;
  }

  async function classifySemanticItems(task, items, semanticPlan) {
    if (!items.length) return [];
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('缺少 OPENAI_API_KEY，无法对新增语义项进行分类');
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4o';
    const taxonomy = semanticPlan.taxonomy || [];
    const output = [];
    for (let offset = 0; offset < items.length; offset += SEMANTIC_BATCH_SIZE) {
      const batch = items.slice(offset, offset + SEMANTIC_BATCH_SIZE);
      const batchNumber = Math.floor(offset / SEMANTIC_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(items.length / SEMANTIC_BATCH_SIZE);
      publish(task, 'classify_progress', {
        message: `正在分类第 ${batchNumber}/${totalBatches} 批（共 ${batch.length} 条）...`,
        batch: batchNumber,
        totalBatches,
        batchSize: batch.length,
        classified: output.length,
        total: items.length,
      });
      const prompt = [
        '你是语义映射器，只输出 JSON 数组，不要输出 Markdown。',
        '请根据用户需求和标签体系，把每个 key 映射到一个业务标签。',
        '必须只使用 taxonomy 中的标签；不确定时使用“未分类”或最接近的待复核标签，并降低 confidence。',
        '',
        '【用户需求】',
        task.requirement,
        '',
        '【标签体系 taxonomy】',
        JSON.stringify(taxonomy),
        '',
        '【语义列】',
        JSON.stringify(semanticPlan.subject_columns || []),
        '',
        '【待分类 items】',
        JSON.stringify(batch.map((item) => ({ key: item.key, sample: item.sample, count: item.count }))),
        '',
        '输出格式：[{"key":"原 key","label":"标签","confidence":0.0,"reason":"简短理由"}]',
      ].join('\n');
      const text = await callOpenAiCompatible([
        { role: 'system', content: '你只做语义映射，输出合法 JSON 数组。' },
        { role: 'user', content: prompt },
      ], 0, { taskId: task.id, phase: 'semantic_classify', batch: batchNumber }, { stream: false });
      const rows = extractJsonArray(text || '');
      const byKey = new Map(rows.map((row) => [String(row.key || ''), row]));
      for (const item of batch) {
        const row = byKey.get(item.key) || {};
        const label = !taxonomy.length || taxonomy.includes(row.label) ? (row.label || '未分类') : '未分类';
        output.push({
          key: item.key,
          label,
          confidence: Number(row.confidence || 0),
          reason: row.reason || '',
          source: 'llm',
        });
      }
      publish(task, 'classify_progress', {
        message: `第 ${batchNumber}/${totalBatches} 批分类完成，累计已分类 ${output.length}/${items.length}`,
        batch: batchNumber,
        totalBatches,
        classified: output.length,
        total: items.length,
      });
    }
    return output;
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
      '禁止在 Python 中用 if/elif/else、正则、str.contains 或关键词包含规则对非结构化文本做业务归类。',
      '如果读取多行表头或产生 MultiIndex columns，写出 Excel 前必须先把每个输出 DataFrame 的 columns 扁平化为一维唯一字符串。',
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
      '- 禁止在 Python 代码中使用 if/elif/else、正则表达式、str.contains 或关键词表对“摘要/备注/评论/描述/科目名称”等非结构化文本做业务归类。',
      '- 如果任务需要语义分类，必须依赖 agent_plan.semanticPlan 中给出的映射结果；代码只能负责读取、匹配、贴标、计算和输出。',
      '- 所有写入 Excel 的 DataFrame 必须是一维列名；如果用 header=[0, 1] 或任何 MultiIndex 表头读取，必须先把 columns 转成一维、唯一、非空字符串。',
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
      '- 如果多行表头或合并单元格导致列名为空，应根据 rawRows 合成可用列名；优先读取 header=None 后自行拼接列名，避免直接保留 pandas MultiIndex columns。',
      '- 如果用户指定 Sheet1，优先读取 Sheet1；否则使用 metadata.sheetName。',
      '',
      '【Excel 写出要求】',
      '- 写出前必须保证每个输出 DataFrame.columns 都是普通 Index，不是 MultiIndex。',
      '- 列名必须扁平化为字符串，例如“期末余额_贷方”；重复列名必须加后缀保证唯一。',
      '- 禁止把 MultiIndex columns 的 DataFrame 直接传给 to_excel(index=False)。',
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
      `agent_tool_trace = ${JSON.stringify(compactAgentToolTraceForCode(task.agentTrace || []))}`,
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
      '如果代码读取多行表头或产生 MultiIndex columns，写出 Excel 前必须先把所有输出 DataFrame 的 columns 扁平化为一维唯一字符串。',
    ].join('\n');
    const modelText = await callOpenAiCompatible([
      { role: 'system', content: repairSystemPrompt },
      { role: 'user', content: `请修复以下代码。整个回复只能是一个 Markdown Python 代码块。\n\n【执行合同】\n- 整个回复只能是一个 \`\`\`python 代码块，代码块外不能有任何文字。\n- 必须使用 INPUT_FILE 和 OUTPUT_FILE，禁止重新赋值。\n- 禁止硬编码 input.xlsx/output.xlsx。\n- 禁止导入 os/sys/pathlib/subprocess/requests/socket/urllib/http/shutil/ctypes。\n- 禁止调用 globals/locals/open/eval/exec/compile/__import__。\n- 禁止示例数据，必须处理真实上传文件。\n- 必须 import pandas as pd。\n- 写出 Excel 前必须保证所有输出 DataFrame.columns 是一维唯一字符串；如果原代码使用 header=[0, 1] 或 MultiIndex columns，必须先扁平化列名。\n- 禁止把 MultiIndex columns 的 DataFrame 直接 to_excel(index=False)。\n\n【原代码】\n${task.generatedCode}\n\n【报错】\n${traceback}\n\n【上下文】\nmetadata_json = ${JSON.stringify(task.metadata)}\nworkbook_profile = ${JSON.stringify(task.workbookProfile || {})}\nuser_requirement = ${task.requirement}\nagent_plan = ${JSON.stringify(task.agentPlan || {})}\nagent_exploration_summary = ${task.agentExplorationSummary || '无'}\nagent_tool_trace = ${JSON.stringify(compactAgentToolTraceForCode(task.agentTrace || []))}` },
    ], 0, { taskId: task.id, phase: 'repair_code' });
    const code = extractCodeBlock(modelText);
    if (!code || isSuspiciousGeneratedCode(code)) {
      throw new Error('模型修复结果未返回合法 Markdown Python 代码块，或包含沙盒禁用/硬编码模式，已拒绝执行。');
    }
    validateGeneratedCodeContract(code);
    return code;
  }

  return {
    needsClarification,
    summarizeModelRequest,
    callOpenAiCompatible,
    extractCodeBlock,
    buildWorkbookIndex,
    runExcelTool,
    refineTaskDraft,
    tryPlanFromMetadata,
    exploreDataWithTools,
    routeTaskIntent,
    classifySemanticItems,
    generateCode,
    repairCode,
  };
}

module.exports = { createAgentServices };

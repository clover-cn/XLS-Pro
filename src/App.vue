<template>
  <main class="app-shell">
    <section class="workspace">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">AI</span>
          <div>
            <h1>XLS-Pro</h1>
            <p>AI驱动的表格自动化工具。</p>
          </div>
        </div>

        <form class="upload-form" @submit.prevent="createTask">
          <label class="field">
            <span>源文件</span>
            <input name="sourceFile" type="file" accept=".csv,.xlsx" @change="onFileChange" />
          </label>

          <label class="field">
            <span>核心需求</span>
            <textarea v-model="requirement" name="requirement" rows="6" placeholder="例如：根据这个序时账编制现金流量表，并输出分类汇总。"></textarea>
          </label>

          <label class="field">
            <span>本次特例规则</span>
            <textarea v-model="temporaryRules" name="temporaryRules" rows="4" placeholder="例如：所有带有“退款”的摘要视为负向流水。"></textarea>
          </label>

          <label class="field">
            <span>表头/结构提取行数</span>
            <input v-model.number="previewRows" name="previewRows" type="number" min="1" max="50" />
          </label>

          <button class="primary-button" type="submit" :disabled="isSubmitting || !selectedFile || !requirement.trim()">
            {{ isSubmitting ? '创建中' : '创建处理任务' }}
          </button>
        </form>

        <div class="rule-editor">
          <div class="section-title">
            <h2>长期规则库</h2>
            <button type="button" @click="loadRules">刷新</button>
          </div>
          <div class="rule-list">
            <article v-for="rule in rules" :key="rule.id" class="rule-item">
              <div class="rule-content">
                <strong>{{ rule.condition }}</strong>
                <span>{{ rule.action }}</span>
              </div>
              <button type="button" class="icon-button" @click="deleteRule(rule.id)" title="删除规则">×</button>
            </article>
            <p v-if="rules.length === 0" class="muted" style="font-size: 13px;">暂无长期规则</p>
          </div>
          <form class="add-rule-form" @submit.prevent="addRule">
            <input v-model="newRule.condition" placeholder="条件 (如: 遇到退款)" required />
            <input v-model="newRule.action" placeholder="动作 (如: 记为负数)" required />
            <button type="submit" :disabled="!newRule.condition || !newRule.action">添加</button>
          </form>
        </div>
      </aside>

      <section class="main-panel">
        <header class="status-bar">
          <div>
            <span class="eyebrow">当前状态</span>
            <h2>{{ statusLabel }}</h2>
          </div>
          <div class="status-actions">
            <button v-if="canCancelTask" type="button" class="danger-button" :disabled="isCancelling" @click="cancelTask">
              {{ isCancelling ? '停止中' : '停止任务' }}
            </button>
            <a v-if="task?.outputReady" class="download-link" :href="downloadUrl">下载结果</a>
            <a v-if="task" class="download-link" :href="`/api/tasks/${task.id}/logs`" target="_blank" rel="noreferrer">查看日志</a>
          </div>
        </header>

        <section v-if="!task" class="empty-state">
          <h2>上传表格后开始任务</h2>
          <p>系统会提取结构信息，再让模型按需搜索和读取局部行，最后生成 pandas 脚本。</p>
        </section>

        <template v-else>
          <section class="console-grid">
            <article class="panel log-panel">
              <div class="panel-header">
                <div>
                  <h3>实时日志</h3>
                  <p class="muted">任务日志会自动刷新，包含工具探索、模型生成、沙盒执行和错误信息。</p>
                </div>
                <button type="button" @click="fetchTaskLogs">刷新</button>
              </div>
              <div class="terminal-window">
                <div class="log-output" ref="logContainer">
                  <div v-for="(line, index) in parsedLogLines" :key="index" :class="['log-line', `log-state-${line.state}`]">
                    <template v-if="!line.raw && line.time">
                      <span class="log-time">[{{ line.time }}]</span>
                      <span class="log-arrow">></span>
                    </template>
                    <span class="log-text">{{ line.text }}</span>
                  </div>
                  <div><span class="cursor-blink-inline"></span></div>
                </div>
              </div>
            </article>

            <article class="panel execution-panel" :class="{ 'is-active-agent': task && ['exploring_data', 'generating_code', 'executing', 'repairing'].includes(task.state) }">
              <div class="panel-header">
                <div>
                  <h3>Python 执行窗口</h3>
                  <p class="muted">{{ executionMessage }}</p>
                </div>
                <span class="status-pill" :class="`state-${task.state}`">{{ statusLabel }}</span>
              </div>

              <div class="execution-summary">
                <div>
                  <span>代码</span>
                  <strong>{{ task.generatedCode ? `${task.generatedCode.length} 字符` : '等待生成' }}</strong>
                </div>
                <div>
                  <span>结果</span>
                  <strong>{{ task.outputReady ? '已生成' : '未生成' }}</strong>
                </div>
                <div>
                  <span>更新时间</span>
                  <strong>{{ formatTime(task.updatedAt) }}</strong>
                </div>
              </div>

              <div v-if="task.state === 'failed'" class="error-box">
                {{ task.message }}
              </div>

              <div v-if="task.outputReady" class="success-box" :class="{ 'has-warning': task.executionWarning }">
                <span>{{ task.executionWarning ? '结果文件已生成，可下载；执行过程中存在警告。' : '结果文件已生成，可以下载。' }}</span>
                <a class="download-link" :href="downloadUrl">下载结果</a>
              </div>

              <div v-if="task.outputReady && task.executionWarning" class="warning-box">
                {{ task.executionWarning }}
              </div>

              <pre class="code-window">{{ task.generatedCode || '模型生成 Python 代码后会显示在这里。' }}</pre>
            </article>
          </section>

          <section class="grid">
            <article class="panel">
              <h3>文件元数据</h3>
              <dl class="meta-list">
                <div>
                  <dt>文件</dt>
                  <dd>{{ task.filename }}</dd>
                </div>
                <div>
                  <dt>行数</dt>
                  <dd>{{ task.metadata?.totalRows ?? '-' }}</dd>
                </div>
                <div>
                  <dt>类型</dt>
                  <dd>{{ task.metadata?.fileKind ?? '-' }}</dd>
                </div>
                <div>
                  <dt>结构行数</dt>
                  <dd>{{ task.metadata?.previewRows ?? task.previewRows ?? '-' }}</dd>
                </div>
                <div>
                  <dt>工作表</dt>
                  <dd>{{ task.metadata?.sheetName ?? '-' }}</dd>
                </div>
                <div>
                  <dt>推测表头</dt>
                  <dd>第 {{ task.metadata?.detectedHeaderRowNumber ?? '-' }} 行</dd>
                </div>
              </dl>
              <div class="columns">
                <span v-for="column in task.metadata?.columns || []" :key="column.name">
                  {{ column.name }} · {{ column.type }}
                </span>
              </div>
            </article>

            <article class="panel">
              <h3>召回规则</h3>
              <div v-if="task.retrievedRules.length" class="rule-list compact">
                <article v-for="rule in task.retrievedRules" :key="rule.id" class="rule-item">
                  <strong>{{ rule.condition }}</strong>
                  <span>{{ rule.action }}</span>
                </article>
              </div>
              <p v-else class="muted">暂无命中规则。</p>
            </article>
          </section>

          <section class="panel">
            <h3>表头/结构预览</h3>
            <div class="table-wrap">
              <table v-if="rawColumnIndexes.length">
                <thead>
                  <tr>
                    <th>行号</th>
                    <th v-for="index in rawColumnIndexes" :key="index">列 {{ index + 1 }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in task.metadata?.rawRows || []" :key="row.rowNumber">
                    <td>{{ row.rowNumber }}</td>
                    <td v-for="index in rawColumnIndexes" :key="index">{{ row.values[index] }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="muted">元数据解析完成后显示提取的结构行。</p>
            </div>
            <p v-if="task.metadata?.mergedCells?.length" class="muted">
              合并单元格：{{ mergedCellsText }}
            </p>
          </section>


        </template>
      </section>
    </section>

    <div v-if="task?.state === 'needs_clarification' && !clarificationDismissed" class="dialog-backdrop">
      <section class="dialog">
        <h2>需要人工确认</h2>
        <p class="muted">Agent 需要你补充以下信息后才会继续生成代码。</p>
        <ul v-if="clarificationQuestions.length">
          <li v-for="question in clarificationQuestions" :key="question">{{ question }}</li>
        </ul>
        <div v-else class="error-box">
          未收到具体问题。请查看实时日志，或取消后重新创建任务。
        </div>
        <textarea v-model="clarificationAnswer" name="clarificationAnswer" rows="5" placeholder="请逐条回答上面的问题。"></textarea>
        <div class="dialog-actions">
          <button type="button" @click="cancelClarification">取消</button>
          <button class="primary-button" type="button" :disabled="!clarificationAnswer.trim()" @click="submitClarification">
            提交并继续
          </button>
        </div>
      </section>
    </div>

    <!-- 悬浮 Agent 追踪球 -->
    <div class="floating-agent-trigger" v-if="task && task.agentTrace && task.agentTrace.length > 0" :class="{ 'is-tracing': isAgentTracing }" @click="showTracePanel = true" title="查看 Agent 工具调用">
      <svg v-if="isAgentTracing" class="spinner-svg trigger-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
      <svg v-else class="trigger-icon" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
      <span v-if="isAgentTracing" class="float-pulse"></span>
    </div>

    <!-- Agent 工具调用详情抽屉侧边栏 -->
    <div v-if="showTracePanel" class="trace-drawer-backdrop" @click.self="showTracePanel = false">
      <div class="trace-drawer">
        <div class="trace-drawer-header">
          <div>
            <h3>Agent 思考与工具调用</h3>
            <span class="trace-count-badge">共 {{ task?.agentTrace?.length || 0 }} 步</span>
          </div>
          <button type="button" class="icon-button close-drawer" @click="showTracePanel = false" title="关闭">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="trace-drawer-content">
          <div class="agent-traces-list">
            <details v-for="(trace, index) in task?.agentTrace" :key="index" class="trace-details-box" :open="!trace.result || index === task?.agentTrace?.length! - 1">
              <summary>
                <div class="summary-left">
                  <span class="status-icon" :class="{ 'is-running': !trace.result, 'is-done': trace.result }">
                    <svg v-if="trace.result" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="spinner-svg"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
                  </span>
                  <span class="summary-copy">
                    <span class="tool-name">{{ trace.toolName }}</span>
                    <span class="tool-reason">{{ formatTraceReason(trace) }}</span>
                  </span>
                </div>
                <span class="trace-time">{{ formatTime(trace.at) }}</span>
              </summary>
              <div class="trace-body">
                <div class="trace-section">
                  <div class="trace-label">调用参数 (Arguments)</div>
                  <pre class="trace-code">{{ JSON.stringify(trace.args, null, 2) }}</pre>
                </div>
                <div class="trace-section" v-if="trace.result">
                  <div class="trace-label">返回结果 (Result)</div>
                  <pre class="trace-code">{{ JSON.stringify(trace.result, null, 2) }}</pre>
                </div>
                <div class="trace-section" v-else>
                  <div class="trace-label is-running-text">工具执行中，等待返回...</div>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  </main>


</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';

type ColumnSummary = {
  name: string;
  type: string;
};

type MetadataSummary = {
  fileKind: string;
  sheetName?: string;
  sheetNames?: string[];
  totalRows: number;
  totalColumns?: number;
  previewRows?: number;
  rawRows?: { rowNumber: number; values: string[] }[];
  mergedCells?: { range: string; value: string }[];
  detectedHeaderRowNumber?: number;
  columns: ColumnSummary[];
};

type KnowledgeRule = {
  id: string;
  condition: string;
  action: string;
  tags?: string[];
  score?: number;
};

type AgentTrace = {
  toolName: string;
  reason?: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  at: string;
};

type Task = {
  id: string;
  filename: string;
  fileHash?: string;
  requirement: string;
  temporaryRules: string;
  previewRows?: number;
  metadata: MetadataSummary | null;
  retrievedRules: KnowledgeRule[];
  clarifications: { answer: string; at: string }[];
  generatedCode: string;
  state: string;
  message: string;
  outputReady: boolean;
  executionWarning?: string;
  indexStatus?: string;
  indexReused?: boolean;
  workbookProfile?: Record<string, unknown> | null;
  agentPlan?: Record<string, unknown> | null;
  validationReport?: Record<string, unknown> | null;
  agentTrace?: AgentTrace[];
  agentExplorationSummary?: string;
  createdAt: string;
  updatedAt: string;
  questions?: string[];
};

type AgentEvent = {
  type: string;
  at: string;
  state?: string;
  message?: string;
  questions?: string[];
  answer?: string;
  code?: string;
  error?: string;
  toolName?: string;
  reason?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  report?: Record<string, unknown>;
  indexedRows?: number;
  totalRows?: number | null;
  percent?: number | null;
  sheetName?: string;
  task?: Task;
};

const selectedFile = ref<File | null>(null);
const requirement = ref('');
const temporaryRules = ref('');
const previewRows = ref(3);
const clarificationAnswer = ref('');
const rules = ref<KnowledgeRule[]>([]);
const newRule = ref({ condition: '', action: '' });
const task = ref<Task | null>(null);
const events = ref<AgentEvent[]>([]);
const logText = ref('');
const isSubmitting = ref(false);
const isCancelling = ref(false);
const eventSource = ref<EventSource | null>(null);
const currentQuestions = ref<string[]>([]);
const clarificationDismissed = ref(false);
const taskPollingTimer = ref<number | null>(null);
const logPollingTimer = ref<number | null>(null);

const showTracePanel = ref(false);
const isAgentTracing = computed(() => {
  const trace = task.value?.agentTrace;
  if (!trace || trace.length === 0) return false;
  return !trace[trace.length - 1].result;
});

function formatTraceReason(trace: AgentTrace) {
  const reason = (trace.reason || '').trim();
  return reason || `我需要调用 ${trace.toolName} 来继续探索表格数据。`;
}

const logContainer = ref<HTMLElement | null>(null);

const parsedLogLines = computed(() => {
  if (!logText.value) {
    return [...events.value].reverse().map(event => {
      const time = formatTime(event.at);
      const text = event.message || event.answer || event.error || event.state || event.type || '已更新';
      return {
        time,
        text,
        state: event.state || event.type || 'info',
        raw: false
      };
    });
  }

  return logText.value.split('\n').filter(line => line.trim()).map(line => {
    try {
      const obj = JSON.parse(line);
      const time = obj.at ? formatTime(obj.at) : '';
      const text = obj.message || obj.answer || obj.error || obj.state || obj.type || line;
      return {
        time,
        text,
        state: obj.state || obj.type || (obj.error ? 'failed' : 'info'),
        raw: false
      };
    } catch (e) {
      return {
        time: '',
        text: line,
        state: 'raw',
        raw: true
      };
    }
  });
});

watch(parsedLogLines, async () => {
  await nextTick();
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
}, { deep: true });

const statusText: Record<string, string> = {
  uploaded: '文件已上传',
  metadata_ready: '元数据已解析',
  indexing: '正在构建索引',
  retrieving_rules: '正在召回规则',
  exploring_data: '正在探索表格',
  needs_clarification: '等待人工确认',
  generating_code: '正在生成代码',
  executing: '正在沙盒执行',
  repairing: '正在自修复',
  completed: '处理完成',
  failed: '处理失败',
  cancelled: '已停止',
};

const statusLabel = computed(() => {
  if (!task.value) return '等待创建任务';
  return statusText[task.value.state] || task.value.message || task.value.state;
});

const downloadUrl = computed(() => (task.value ? `/api/tasks/${task.value.id}/output` : '#'));

const terminalStates = new Set(['completed', 'failed', 'needs_clarification', 'cancelled']);
const cancellableStates = new Set(['uploaded', 'metadata_ready', 'indexing', 'retrieving_rules', 'exploring_data', 'generating_code', 'executing', 'repairing', 'needs_clarification']);

const canCancelTask = computed(() => Boolean(task.value && cancellableStates.has(task.value.state)));

const executionMessage = computed(() => {
  if (!task.value) return '等待创建任务';
  if (task.value.state === 'indexing') return '正在为大型表格构建本地查询索引。';
  if (task.value.state === 'exploring_data') return '模型正在调用工具搜索表格并读取指定行。';
  if (task.value.state === 'generating_code') return '模型正在生成可执行 Python 代码。';
  if (task.value.state === 'executing') return '沙盒正在运行生成的 Python 脚本。';
  if (task.value.state === 'repairing') return '脚本执行失败，模型正在自修复并重试。';
  if (task.value.state === 'completed' && task.value.executionWarning) return '结果文件已生成，执行过程中存在警告。';
  if (task.value.state === 'completed') return '沙盒执行完成，结果文件已就绪。';
  if (task.value.state === 'failed') return '任务失败，请查看日志和错误信息。';
  if (task.value.state === 'cancelled') return '任务已停止，不会继续调用模型、索引工具或沙盒。';
  return task.value.message || '任务处理中';
});

const clarificationQuestions = computed(() => {
  const fromTask = task.value?.questions || [];
  if (fromTask.length) return fromTask;
  return currentQuestions.value;
});

const rawColumnIndexes = computed(() => {
  const rows = task.value?.metadata?.rawRows || [];
  const maxLength = rows.reduce((max, row) => Math.max(max, row.values.length), 0);
  return Array.from({ length: Math.min(maxLength, 24) }, (_, index) => index);
});

const mergedCellsText = computed(() => (task.value?.metadata?.mergedCells || [])
  .map((cell) => `${cell.range}${cell.value ? `=${cell.value}` : ''}`)
  .join('，'));

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] || null;
}

async function loadRules() {
  const response = await fetch('/api/rules');
  rules.value = await response.json();
}

async function addRule() {
  if (!newRule.value.condition || !newRule.value.action) return;
  const response = await fetch('/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newRule.value),
  });
  if (response.ok) {
    newRule.value = { condition: '', action: '' };
    await loadRules();
  }
}

async function deleteRule(id: string) {
  if (!confirm('确定要删除这条长期规则吗？')) return;
  const response = await fetch(`/api/rules/${id}`, { method: 'DELETE' });
  if (response.ok) {
    await loadRules();
  }
}

async function refreshTask(id: string) {
  const response = await fetch(`/api/tasks/${id}`);
  if (response.ok) {
    task.value = await response.json();
    if (task.value?.questions?.length) {
      currentQuestions.value = task.value.questions;
    }
    if (task.value && terminalStates.has(task.value.state)) {
      stopPolling();
      fetchTaskLogs();
    }
  }
}

async function fetchTaskLogs() {
  if (!task.value) return;
  const response = await fetch(`/api/tasks/${task.value.id}/logs`);
  if (response.ok) {
    logText.value = await response.text();
  }
}

function startPolling(id: string) {
  stopPolling();
  taskPollingTimer.value = window.setInterval(() => refreshTask(id), 2000);
  logPollingTimer.value = window.setInterval(fetchTaskLogs, 2000);
}

function stopPolling() {
  if (taskPollingTimer.value) {
    window.clearInterval(taskPollingTimer.value);
    taskPollingTimer.value = null;
  }
  if (logPollingTimer.value) {
    window.clearInterval(logPollingTimer.value);
    logPollingTimer.value = null;
  }
}

function connectEvents(id: string) {
  eventSource.value?.close();
  events.value = [];
  const source = new EventSource(`/api/tasks/${id}/events`);
  eventSource.value = source;

  source.addEventListener('connected', (message) => {
    const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
    events.value.unshift({ ...event, message: '事件流已连接' });
    if (event.task) task.value = event.task;
    const questions = event.questions || event.task?.questions || [];
    if (questions.length) currentQuestions.value = questions;
    fetchTaskLogs();
  });

  source.addEventListener('state', (message) => {
    const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
    events.value.unshift(event);
    if (event.task) task.value = event.task;
    if (event.task?.questions?.length) currentQuestions.value = event.task.questions;
    if (event.state !== 'needs_clarification') clarificationDismissed.value = false;
    if (event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled') {
      refreshTask(id);
    }
    fetchTaskLogs();
  });

  source.addEventListener('code', (message) => {
    const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
    events.value.unshift({ ...event, code: 'Python 代码已生成' });
    if (task.value) task.value.generatedCode = event.code || task.value.generatedCode;
    fetchTaskLogs();
  });

  source.addEventListener('warning', (message) => {
    const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
    events.value.unshift(event);
    if (event.task) task.value = event.task;
    fetchTaskLogs();
  });

  ['indexing', 'index_progress', 'index_ready', 'tool_call', 'tool_result', 'tool_budget_extended', 'agent_summary', 'validation'].forEach((eventName) => {
    source.addEventListener(eventName, (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
      events.value.unshift(event);
      if (event.task) task.value = event.task;
      fetchTaskLogs();
    });
  });

  source.addEventListener('error', (message) => {
    if ((message as MessageEvent).data) {
      events.value.unshift(JSON.parse((message as MessageEvent).data) as AgentEvent);
    }
    fetchTaskLogs();
  });

  source.addEventListener('clarification', (message) => {
    events.value.unshift(JSON.parse((message as MessageEvent).data) as AgentEvent);
    fetchTaskLogs();
  });
}

async function createTask() {
  if (!selectedFile.value) return;
  isSubmitting.value = true;
  try {
    const form = new FormData();
    form.append('file', selectedFile.value);
    form.append('requirement', requirement.value);
    form.append('temporaryRules', temporaryRules.value);
    form.append('previewRows', String(previewRows.value || 3));
    const response = await fetch('/api/tasks', { method: 'POST', body: form });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || '任务创建失败');
    }
    task.value = await response.json();
    currentQuestions.value = [];
    clarificationDismissed.value = false;
    logText.value = '';
    if (task.value) {
      connectEvents(task.value.id);
      startPolling(task.value.id);
    }
    fetchTaskLogs();
  } catch (error) {
    alert(error instanceof Error ? error.message : '任务创建失败');
  } finally {
    isSubmitting.value = false;
  }
}

async function cancelTask() {
  if (!task.value || isCancelling.value) return;
  if (!confirm('确定要停止当前任务吗？')) return;
  isCancelling.value = true;
  try {
    const response = await fetch(`/api/tasks/${task.value.id}/cancel`, { method: 'POST' });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || '停止任务失败');
    }
    task.value = await response.json();
    stopPolling();
    fetchTaskLogs();
  } catch (error) {
    alert(error instanceof Error ? error.message : '停止任务失败');
  } finally {
    isCancelling.value = false;
  }
}

async function submitClarification() {
  if (!task.value) return;
  const response = await fetch(`/api/tasks/${task.value.id}/clarifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: clarificationAnswer.value }),
  });
  if (response.ok) {
    task.value = await response.json();
    clarificationAnswer.value = '';
    currentQuestions.value = [];
    clarificationDismissed.value = false;
    if (task.value) {
      startPolling(task.value.id);
    }
    fetchTaskLogs();
  }
}

function cancelClarification() {
  clarificationDismissed.value = true;
  clarificationAnswer.value = '';
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}


onMounted(loadRules);

onUnmounted(() => {
  eventSource.value?.close();
  stopPolling();
});
</script>

<style lang="scss">
@import "./assets/style/App.scss";
</style>

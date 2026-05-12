<template>
  <main class="app-shell">
    <section class="workspace">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">AW</span>
          <div>
            <h1>AI 表格自动化</h1>
            <p>本地沙盒执行，模型只接收元数据与样本。</p>
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
              <strong>{{ rule.condition }}</strong>
              <span>{{ rule.action }}</span>
            </article>
          </div>
        </div>
      </aside>

      <section class="main-panel">
        <header class="status-bar">
          <div>
            <span class="eyebrow">当前状态</span>
            <h2>{{ statusLabel }}</h2>
          </div>
          <div class="status-actions">
            <a v-if="task?.outputReady" class="download-link" :href="downloadUrl">下载结果</a>
            <a v-if="task" class="download-link" :href="`/api/tasks/${task.id}/logs`" target="_blank" rel="noreferrer">查看日志</a>
          </div>
        </header>

        <section v-if="!task" class="empty-state">
          <h2>上传表格后开始任务</h2>
          <p>系统会提取前 N 行表头/结构信息、合并单元格和用户需求，再交给模型生成 pandas 脚本。</p>
        </section>

        <template v-else>
          <section class="console-grid">
            <article class="panel log-panel">
              <div class="panel-header">
                <div>
                  <h3>实时日志</h3>
                  <p class="muted">任务日志会自动刷新，包含模型生成、沙盒执行和错误信息。</p>
                </div>
                <button type="button" @click="fetchTaskLogs">刷新</button>
              </div>
              <div class="terminal-window">
                <pre class="log-output"><span>{{ logText || compactEventsLog }}</span><span class="cursor-blink-inline"></span></pre>
              </div>
            </article>

            <article class="panel execution-panel" :class="{ 'is-active-agent': task && ['generating_code', 'executing', 'repairing'].includes(task.state) }">
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

              <div v-if="task.outputReady" class="success-box">
                结果文件已生成，可以下载。
                <a class="download-link" :href="downloadUrl">下载结果</a>
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

          <section class="timeline">
            <h3>任务事件</h3>
            <ol>
              <li v-for="(event, index) in events" :key="`${event.at}-${index}`">
                <span>{{ formatTime(event.at) }}</span>
                <strong>{{ event.state || event.type }}</strong>
                <p>{{ eventText(event) }}</p>
              </li>
            </ol>
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
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

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

type Task = {
  id: string;
  filename: string;
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
  task?: Task;
};

const selectedFile = ref<File | null>(null);
const requirement = ref('');
const temporaryRules = ref('');
const previewRows = ref(3);
const clarificationAnswer = ref('');
const rules = ref<KnowledgeRule[]>([]);
const task = ref<Task | null>(null);
const events = ref<AgentEvent[]>([]);
const logText = ref('');
const isSubmitting = ref(false);
const eventSource = ref<EventSource | null>(null);
const currentQuestions = ref<string[]>([]);
const clarificationDismissed = ref(false);
const taskPollingTimer = ref<number | null>(null);
const logPollingTimer = ref<number | null>(null);

const statusText: Record<string, string> = {
  uploaded: '文件已上传',
  metadata_ready: '元数据已解析',
  retrieving_rules: '正在召回规则',
  needs_clarification: '等待人工确认',
  generating_code: '正在生成代码',
  executing: '正在沙盒执行',
  repairing: '正在自修复',
  completed: '处理完成',
  failed: '处理失败',
};

const statusLabel = computed(() => {
  if (!task.value) return '等待创建任务';
  return statusText[task.value.state] || task.value.message || task.value.state;
});

const downloadUrl = computed(() => (task.value ? `/api/tasks/${task.value.id}/output` : '#'));

const terminalStates = new Set(['completed', 'failed', 'needs_clarification']);

const executionMessage = computed(() => {
  if (!task.value) return '等待创建任务';
  if (task.value.state === 'generating_code') return '模型正在生成可执行 Python 代码。';
  if (task.value.state === 'executing') return '沙盒正在运行生成的 Python 脚本。';
  if (task.value.state === 'repairing') return '脚本执行失败，模型正在自修复并重试。';
  if (task.value.state === 'completed') return '沙盒执行完成，结果文件已就绪。';
  if (task.value.state === 'failed') return '任务失败，请查看日志和错误信息。';
  return task.value.message || '任务处理中';
});

const compactEventsLog = computed(() => events.value
  .map((event) => `[${formatTime(event.at)}] ${event.state || event.type} ${eventText(event)}`)
  .join('\n'));

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
    if (event.state === 'completed' || event.state === 'failed') {
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
    events.value.unshift(JSON.parse((message as MessageEvent).data) as AgentEvent);
    fetchTaskLogs();
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
    connectEvents(task.value.id);
    startPolling(task.value.id);
    fetchTaskLogs();
  } catch (error) {
    alert(error instanceof Error ? error.message : '任务创建失败');
  } finally {
    isSubmitting.value = false;
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
    startPolling(task.value.id);
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

function eventText(event: AgentEvent) {
  const questions = event.task?.questions || [];
  if (event.questions?.length) return `${event.message || '需要人工确认'}：${event.questions.join('；')}`;
  if (questions.length) return `${event.message || '需要人工确认'}：${questions.join('；')}`;
  return event.message || event.answer || event.code || event.error || '已更新';
}

onMounted(loadRules);

onUnmounted(() => {
  eventSource.value?.close();
  stopPolling();
});
</script>

<style>
:root {
  color: #18201c;
  background: #f4f6f2;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f4f6f2;
}

button,
input,
textarea {
  font: inherit;
}

button,
.download-link {
  min-height: 40px;
  border: 1px solid #aeb8ad;
  border-radius: 6px;
  background: #ffffff;
  color: #1d2a22;
  cursor: pointer;
  padding: 0 14px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.primary-button {
  border-color: #1f7a57;
  background: #1f7a57;
  color: #ffffff;
  font-weight: 700;
}

.app-shell {
  min-height: 100vh;
  font-family: Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
}

.workspace {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
}

.sidebar {
  border-right: 1px solid #d9dfd7;
  background: #ffffff;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.brand {
  display: flex;
  gap: 14px;
  align-items: center;
}

.brand-mark {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: #d9eee5;
  color: #0c6845;
  display: grid;
  place-items: center;
  font-weight: 800;
}

.brand h1,
.brand p,
.section-title h2,
.panel h3,
.empty-state h2,
.dialog h2 {
  margin: 0;
}

.brand h1 {
  font-size: 20px;
}

.brand p,
.muted {
  color: #607067;
}

.upload-form,
.field,
.rule-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field span {
  font-weight: 700;
}

.field input,
.field textarea,
.dialog textarea {
  width: 100%;
  border: 1px solid #cbd4ca;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fbfcfa;
  resize: vertical;
}

.section-title,
.status-bar,
.status-actions,
.dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title h2 {
  font-size: 16px;
}

.rule-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-item {
  border: 1px solid #dbe2d9;
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #fbfcfa;
}

.rule-item strong {
  font-size: 13px;
}

.rule-item span {
  color: #526259;
  font-size: 13px;
}

.main-panel {
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.status-bar {
  border-bottom: 1px solid #d9dfd7;
  padding-bottom: 20px;
}

.eyebrow {
  color: #64736a;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
}

.status-bar h2 {
  margin: 4px 0 0;
  font-size: 28px;
}

.empty-state,
.panel,
.timeline,
.code-panel {
  background: #ffffff;
  border: 1px solid #d9dfd7;
  border-radius: 8px;
  padding: 18px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.console-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 18px;
  align-items: stretch;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.panel-header p {
  margin: 4px 0 0;
}

.log-panel,
.execution-panel {
  min-height: 420px;
  display: flex;
  flex-direction: column;
}

.log-output,
.code-window {
  margin: 0;
  overflow-y: auto;
  overflow-x: hidden;
  max-height: 500px;
  border-radius: 6px;
  padding: 14px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "Fira Code", Consolas, Monaco, "Courier New", Courier, monospace;
}

/* Custom Scrollbar for agent windows */
.log-output::-webkit-scrollbar,
.code-window::-webkit-scrollbar {
  width: 6px;
}
.log-output::-webkit-scrollbar-track,
.code-window::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.2);
}
.log-output::-webkit-scrollbar-thumb,
.code-window::-webkit-scrollbar-thumb {
  background: #3e5a4a;
  border-radius: 3px;
}
.log-output::-webkit-scrollbar-thumb:hover,
.code-window::-webkit-scrollbar-thumb:hover {
  background: #5c856f;
}

.terminal-window {
  flex: 1;
  background: #0a0f0d;
  border-radius: 6px;
  border: 1px solid #1c2b23;
  padding: 14px;
  display: flex;
  flex-direction: column;
  position: relative;
  box-shadow: inset 0 0 20px rgba(12, 104, 69, 0.1);
}

.log-output {
  flex: 1;
  background: transparent;
  color: #4ade80;
  text-shadow: 0 0 4px rgba(74, 222, 128, 0.3);
  padding: 0;
  min-height: 320px;
}

.cursor-blink-inline {
  display: inline-block;
  width: 8px;
  height: 14px;
  background-color: #4ade80;
  box-shadow: 0 0 6px #4ade80;
  animation: blink 1s step-end infinite;
  vertical-align: text-bottom;
  margin-left: 4px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.code-window {
  background: #121815;
  color: #e6f3ed;
  min-height: 260px;
  border: 1px solid #1c2b23;
}

/* Agent Execution Animations */
.execution-panel {
  position: relative;
  overflow: hidden;
  transition: box-shadow 0.3s ease, border-color 0.3s ease;
}

.execution-panel.is-active-agent {
  border-color: #2b8b60;
  box-shadow: 0 0 15px rgba(43, 139, 96, 0.2);
  animation: breathe 2s ease-in-out infinite;
}

.execution-panel.is-active-agent::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 120px;
  background: linear-gradient(
    to bottom,
    rgba(74, 222, 128, 0) 0%,
    rgba(74, 222, 128, 0.05) 50%,
    rgba(74, 222, 128, 0.2) 100%
  );
  border-bottom: 1px solid rgba(74, 222, 128, 0.5);
  box-shadow: 0 5px 15px rgba(74, 222, 128, 0.15);
  animation: scan 2.5s linear infinite;
  pointer-events: none;
  z-index: 10;
}

@keyframes breathe {
  0%, 100% { box-shadow: 0 0 15px rgba(43, 139, 96, 0.1); border-color: #1f7a57; }
  50% { box-shadow: 0 0 25px rgba(43, 139, 96, 0.3); border-color: #4ade80; }
}

@keyframes scan {
  0% { transform: translateY(-120px); }
  100% { transform: translateY(1000px); }
}

.status-pill {
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 800;
  background: #eef2ec;
  color: #405149;
  white-space: nowrap;
}

.state-executing,
.state-generating_code,
.state-repairing {
  background: #fff2c9;
  color: #7a5700;
}

.state-completed {
  background: #dff4e9;
  color: #116442;
}

.state-failed {
  background: #ffe1df;
  color: #9b241a;
}

.execution-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.execution-summary div {
  border: 1px solid #dce4da;
  border-radius: 6px;
  padding: 10px;
  background: #fbfcfa;
}

.execution-summary span {
  display: block;
  color: #607067;
  font-size: 12px;
  margin-bottom: 4px;
}

.execution-summary strong {
  display: block;
  overflow-wrap: anywhere;
}

.error-box,
.success-box {
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
  overflow-wrap: anywhere;
}

.error-box {
  border: 1px solid #f3b0aa;
  background: #fff1ef;
  color: #8c231a;
}

.success-box {
  border: 1px solid #b4dcc8;
  background: #edf8f2;
  color: #195b3f;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.meta-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0;
}

.meta-list div {
  border-left: 3px solid #6a9f89;
  padding-left: 10px;
}

.meta-list dt {
  color: #64736a;
  font-size: 12px;
}

.meta-list dd {
  margin: 4px 0 0;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.columns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.columns span {
  border: 1px solid #cbd8d1;
  border-radius: 999px;
  padding: 6px 10px;
  background: #eef7f2;
  font-size: 12px;
}

.table-wrap {
  overflow: auto;
}

table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  border-bottom: 1px solid #e5eae3;
  padding: 10px;
  text-align: left;
  vertical-align: top;
  max-width: 260px;
  overflow-wrap: anywhere;
}

th {
  background: #eef2ec;
  position: sticky;
  top: 0;
}

.timeline ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timeline li {
  display: grid;
  grid-template-columns: 86px 150px minmax(0, 1fr);
  gap: 12px;
  border-bottom: 1px solid #e6ebe4;
  padding-bottom: 10px;
}

.timeline span {
  color: #64736a;
}

.timeline p {
  margin: 0;
  overflow-wrap: anywhere;
}

.code-panel pre {
  margin: 0;
  max-height: 420px;
  overflow: auto;
  background: #17211d;
  color: #e6f3ed;
  border-radius: 6px;
  padding: 16px;
  font-size: 13px;
  line-height: 1.55;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(24, 32, 28, 0.45);
  display: grid;
  place-items: center;
  padding: 24px;
}

.dialog {
  width: min(640px, 100%);
  background: #ffffff;
  border-radius: 8px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: 0 20px 60px rgba(24, 32, 28, 0.24);
}

.dialog ul {
  margin: 0;
  padding-left: 20px;
}

@media (max-width: 980px) {
  .workspace,
  .grid,
  .console-grid {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #d9dfd7;
  }

  .status-bar,
  .timeline li {
    grid-template-columns: 1fr;
    align-items: flex-start;
  }
}
</style>

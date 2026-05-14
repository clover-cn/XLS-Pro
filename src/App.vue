<template>
  <main class="app-shell">
    <section class="workspace">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">AW</span>
          <div>
            <h1>AI 表格自动化</h1>
            <p>本地沙盒执行，模型可按需读取和搜索表格。</p>
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
            <details v-for="(trace, index) in task?.agentTrace" :key="index" class="trace-details-box" :open="!trace.result || index === task.agentTrace.length - 1">
              <summary>
                <div class="summary-left">
                  <span class="status-icon" :class="{ 'is-running': !trace.result, 'is-done': trace.result }">
                    <svg v-if="trace.result" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="spinner-svg"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
                  </span>
                  <span class="tool-name">{{ trace.toolName }}</span>
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
            <details v-for="(trace, index) in task?.agentTrace" :key="index" class="trace-details-box" :open="!trace.result || index === task.agentTrace.length - 1">
              <summary>
                <div class="summary-left">
                  <span class="status-icon" :class="{ 'is-running': !trace.result, 'is-done': trace.result }">
                    <svg v-if="trace.result" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="spinner-svg"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
                  </span>
                  <span class="tool-name">{{ trace.toolName }}</span>
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
  executionWarning?: string;
  indexStatus?: string;
  workbookProfile?: Record<string, unknown> | null;
  agentPlan?: Record<string, unknown> | null;
  validationReport?: Record<string, unknown> | null;
  agentTrace?: { toolName: string; args: Record<string, unknown>; result?: Record<string, unknown>; at: string }[];
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

const showTracePanel = ref(false);
const isAgentTracing = computed(() => {
  const trace = task.value?.agentTrace;
  if (!trace || trace.length === 0) return false;
  return !trace[trace.length - 1].result;
});

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
};

const statusLabel = computed(() => {
  if (!task.value) return '等待创建任务';
  return statusText[task.value.state] || task.value.message || task.value.state;
});

const downloadUrl = computed(() => (task.value ? `/api/tasks/${task.value.id}/output` : '#'));

const terminalStates = new Set(['completed', 'failed', 'needs_clarification']);

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
    const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
    events.value.unshift(event);
    if (event.task) task.value = event.task;
    fetchTaskLogs();
  });

  ['indexing', 'index_progress', 'index_ready', 'tool_call', 'tool_result', 'agent_summary', 'validation'].forEach((eventName) => {
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
  if (event.type === 'index_progress') return event.message || '正在构建索引';
  if (event.type === 'index_ready') return event.message || '表格索引构建完成';
  if (event.type === 'validation') return event.message || '输出文件校验完成';
  if (event.type === 'tool_call') return `${event.message || '调用表格工具'} ${event.toolName || ''}`;
  if (event.type === 'tool_result') return `${event.toolName || '表格工具'} 已返回摘要`;
  if (event.type === 'agent_summary') return event.message || '数据探索完成';
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
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  background: #fbfcfa;
}

.rule-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rule-item strong {
  font-size: 13px;
}

.rule-item span {
  color: #526259;
  font-size: 13px;
}

.icon-button {
  min-height: auto;
  padding: 0;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #8c9b93;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.icon-button:hover {
  color: #c93b32;
  background: #fbeae9;
  border-radius: 4px;
}

.add-rule-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.add-rule-form input {
  font-size: 13px;
  padding: 8px 10px;
}

.add-rule-form button {
  min-height: 32px;
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
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-line {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  word-break: break-all;
}

.log-time {
  color: #6a9f89;
  font-size: 11px;
  white-space: nowrap;
}

.log-arrow {
  color: #4ade80;
  font-weight: bold;
}

.log-text {
  flex: 1;
}

.log-state-failed, .log-state-error {
  color: #fca5a5;
  text-shadow: 0 0 4px rgba(252, 165, 165, 0.3);
}

.log-state-indexing, .log-state-index_progress, .log-state-index_ready, .log-state-validation,
.log-state-exploring_data, .log-state-tool_call, .log-state-tool_result, .log-state-agent_summary,
.log-state-executing, .log-state-generating_code, .log-state-repairing {
  color: #fde047;
  text-shadow: 0 0 4px rgba(253, 224, 71, 0.3);
}

.log-state-completed {
  color: #86efac;
}

.log-state-raw {
  color: #aeb8ad;
  text-shadow: none;
}

.log-state-info {
  color: #4ade80;
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
.state-indexing,
.state-exploring_data,
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
.warning-box,
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

.warning-box,
.success-box.has-warning {
  border: 1px solid #e0c56b;
  background: #fff9e6;
  color: #6d4f00;
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

/* 新增：Agent 工具调用链样式 */
.agent-traces-container {
  background: #f8faf9;
  border: 1px solid #e1e7e3;
  border-radius: 8px;
  margin-bottom: 16px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
}

.agent-traces-header {
  padding: 12px 16px;
  background: #f1f4f2;
  border-bottom: 1px solid #e1e7e3;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-traces-header h4 {
  margin: 0;
  font-size: 14px;
  color: #2c3631;
  font-weight: 600;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #8c9b93;
  display: inline-block;
}

.pulse-dot.active {
  background-color: #10a37f;
  box-shadow: 0 0 0 0 rgba(16, 163, 127, 0.7);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 163, 127, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 163, 127, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 163, 127, 0); }
}

.trace-count {
  font-size: 12px;
  color: #64746b;
  background: #e1e7e3;
  padding: 2px 8px;
  border-radius: 12px;
}

.agent-traces-list {
  display: flex;
  flex-direction: column;
}

.trace-details-box {
  border-bottom: 1px solid #e1e7e3;
}

.trace-details-box:last-child {
  border-bottom: none;
}

.trace-details-box summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  background: #fff;
  transition: background-color 0.2s;
  list-style: none; /* Hide default triangle */
}
.trace-details-box summary::-webkit-details-marker {
  display: none;
}

.trace-details-box summary:hover {
  background: #f8faf9;
}

.summary-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
}

.status-icon.is-done {
  color: #10a37f;
  background: #e6f6f1;
}

.status-icon.is-running {
  color: #f59e0b;
  background: #fef3c7;
}

.spinner-svg {
  animation: spin 1.5s linear infinite;
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}

.tool-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: #2c3631;
}

.trace-time {
  font-size: 12px;
  color: #8c9b93;
}

.trace-body {
  padding: 16px;
  background: #fafcfb;
  border-top: 1px dashed #eef2f0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.trace-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.trace-label {
  font-size: 12px;
  font-weight: 600;
  color: #64746b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.is-running-text {
  color: #f59e0b;
  animation: pulse-opacity 2s infinite;
}

@keyframes pulse-opacity {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.trace-code {
  margin: 0;
  padding: 12px;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* 新增：悬浮球样式 */
.floating-agent-trigger {
  position: fixed;
  bottom: 40px;
  right: 40px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #10a37f;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(16, 163, 127, 0.3);
  cursor: pointer;
  z-index: 1000;
  transition: transform 0.2s, box-shadow 0.2s;
}

.floating-agent-trigger:hover {
  transform: scale(1.05) translateY(-2px);
  box-shadow: 0 6px 16px rgba(16, 163, 127, 0.4);
}

.floating-agent-trigger.is-tracing {
  background: #2c3631;
  box-shadow: 0 4px 12px rgba(44, 54, 49, 0.3);
}

.trigger-icon {
  width: 28px;
  height: 28px;
}

.float-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: #10a37f;
  border: 2px solid white;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

/* 新增：抽屉侧边栏样式 */
.trace-drawer-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.3);
  z-index: 1001;
  display: flex;
  justify-content: flex-end;
  backdrop-filter: blur(2px);
}

.trace-drawer {
  width: 480px;
  max-width: 90vw;
  height: 100vh;
  background: #fbfcfa;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.trace-drawer-header {
  padding: 20px 24px;
  background: #fff;
  border-bottom: 1px solid #e1e7e3;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.trace-drawer-header h3 {
  margin: 0;
  font-size: 16px;
  color: #2c3631;
  display: inline-block;
  margin-right: 12px;
}

.trace-count-badge {
  font-size: 12px;
  background: #e1e7e3;
  padding: 2px 8px;
  border-radius: 12px;
  color: #526259;
  vertical-align: middle;
}

.trace-drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.close-drawer {
  background: #f1f4f2;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-drawer:hover {
  background: #e1e7e3;
  color: #2c3631;
}

/* 以下复用之前的 .agent-traces-list 等样式，确保嵌套正确即可 */

/* 新增：悬浮球样式 */
.floating-agent-trigger {
  position: fixed;
  bottom: 40px;
  right: 40px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #10a37f;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(16, 163, 127, 0.3);
  cursor: pointer;
  z-index: 1000;
  transition: transform 0.2s, box-shadow 0.2s;
}

.floating-agent-trigger:hover {
  transform: scale(1.05) translateY(-2px);
  box-shadow: 0 6px 16px rgba(16, 163, 127, 0.4);
}

.floating-agent-trigger.is-tracing {
  background: #2c3631;
  box-shadow: 0 4px 12px rgba(44, 54, 49, 0.3);
}

.trigger-icon {
  width: 28px;
  height: 28px;
}

.float-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: #10a37f;
  border: 2px solid white;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

/* 新增：抽屉侧边栏样式 */
.trace-drawer-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.3);
  z-index: 1001;
  display: flex;
  justify-content: flex-end;
  backdrop-filter: blur(2px);
}

.trace-drawer {
  width: 480px;
  max-width: 90vw;
  height: 100vh;
  background: #fbfcfa;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.trace-drawer-header {
  padding: 20px 24px;
  background: #fff;
  border-bottom: 1px solid #e1e7e3;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.trace-drawer-header h3 {
  margin: 0;
  font-size: 16px;
  color: #2c3631;
  display: inline-block;
  margin-right: 12px;
}

.trace-count-badge {
  font-size: 12px;
  background: #e1e7e3;
  padding: 2px 8px;
  border-radius: 12px;
  color: #526259;
  vertical-align: middle;
}

.trace-drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.close-drawer {
  background: #f1f4f2;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-drawer:hover {
  background: #e1e7e3;
  color: #2c3631;
}

/* 以下复用之前的 .agent-traces-list 等样式，确保嵌套正确即可 */
</style>



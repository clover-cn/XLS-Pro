const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { createWorkflow } = require('../server/workflow');
const { createAgentServices } = require('../server/agent-services');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createWorkflowForTest(extractMetadata) {
  return createWorkflow({
    log: () => {},
    publish: () => {},
    publicTask: (task) => task,
    setTaskState: (task, state, message) => {
      task.state = state;
      task.message = message;
    },
    assertTaskNotCancelled: () => {},
    cancelledError: () => new Error('cancelled'),
    isCancelledError: (error) => error?.message === 'cancelled',
    trackChildProcess: () => {},
    isPathInside,
    touchIfExists: () => {},
    extractMetadata,
    retrieveRules: () => [],
    buildWorkbookIndex: async () => ({}),
    tryPlanFromMetadata: () => false,
    exploreDataWithTools: async () => {},
    routeTaskIntent: async () => {},
    classifySemanticItems: async () => [],
    needsClarification: () => [],
    generateCode: async () => '',
    repairCode: async () => '',
    semanticCache: { lookup: () => ({ hits: [] }), upsert: () => ({ saved: 0 }) },
  });
}

async function verifySandboxRejectsFailedResidualOutput() {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-guard-'));
  const source = path.join(taskDir, 'source.xlsx');
  const preload = path.join(taskDir, 'fake-runner-preload.js');
  fs.writeFileSync(source, 'placeholder', 'utf8');
  fs.writeFileSync(preload, [
    'const fs = require("fs");',
    'fs.writeFileSync(process.argv[4], "residual workbook", "utf8");',
    'console.log(JSON.stringify({ ok: false, error: "生成代码执行失败", detail: "NotImplementedError" }));',
    'process.exit(1);',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'generated.py'), [
    'import pandas as pd',
    '',
    'df = pd.read_excel(INPUT_FILE, sheet_name="Sheet1", header=[0, 1])',
    'df.to_excel(OUTPUT_FILE, index=False)',
    '',
  ].join('\n'), 'utf8');

  const workflow = createWorkflowForTest(async () => ({ sheetNames: ['Sheet1'], totalRows: 2, totalColumns: 2 }));
  const oldPythonBin = process.env.PYTHON_BIN;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  const preloadForNodeOptions = preload.replace(/\\/g, '/');
  process.env.PYTHON_BIN = process.execPath;
  process.env.NODE_OPTIONS = `${oldNodeOptions ? `${oldNodeOptions} ` : ''}--require ${preloadForNodeOptions}`;
  let result;
  try {
    result = await workflow.runSandbox({
      id: 'workflow-guard',
      dir: taskDir,
      filePath: source,
      filename: 'source.xlsx',
    });
  } finally {
    if (oldNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = oldNodeOptions;
    }
    if (oldPythonBin === undefined) {
      delete process.env.PYTHON_BIN;
    } else {
      process.env.PYTHON_BIN = oldPythonBin;
    }
  }

  assert(result.ok === false, '沙盒执行失败时不应接受残留 output.xlsx');
  const errorText = `${result.error || ''}\n${result.detail || ''}`;
  assert(/生成代码执行失败/.test(errorText), `错误原因应保留 runner 失败信息，实际为: ${errorText}`);
}

async function verifyResidualOutputValidationFails() {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-validation-'));
  const output = path.join(taskDir, 'output.xlsx');
  fs.writeFileSync(output, 'placeholder', 'utf8');

  const workflow = createWorkflowForTest(async () => ({
    sheetNames: ['Sheet1'],
    sheetName: 'Sheet1',
    totalRows: 1,
    totalColumns: 1,
  }));
  const report = await workflow.validateOutput({ id: 'validation-guard' }, output);

  assert(report.ok === false, '1 行 1 列残缺输出不应通过校验');
  assert(report.warnings.some((warning) => warning.includes('残留文件')), `应报告残留文件风险，实际为: ${report.warnings.join(';')}`);
}

function verifyDirectTextEditRoutesToWorkbookPatch() {
  const services = createAgentServices({
    tasks: new Map(),
    log: () => {},
    publish: () => {},
    publicTask: (task) => task,
    assertTaskNotCancelled: () => {},
    cancelledError: () => new Error('cancelled'),
    trackChildProcess: () => {},
    isPathInside,
  });
  const task = {
    id: 'direct-text-edit',
    requirement: '帮我把“1.7支付杜潇报销费用”改成“1.7支付杜潇报销费用test”，格式保持一致',
    metadata: {
      fileKind: 'xlsx',
      sheetName: 'Sheet1',
      sheetNames: ['Sheet1'],
      detectedHeaderRowNumber: 4,
      rawRows: [{ rowNumber: 4, values: ['日期', '摘要'] }],
      columns: [{ name: '日期' }, { name: '摘要' }],
    },
    agentTrace: [],
  };

  const planned = services.tryPlanFromMetadata(task);
  assert(planned === true, '明确文本替换任务应在元数据阶段直接规划');
  assert(task.agentPlan.executionMode === 'workbook_patch', `应走 workbook_patch，实际为: ${task.agentPlan.executionMode}`);
  assert(task.agentPlan.workbookPatch.mode === 'text_replace', `应使用 text_replace，实际为: ${task.agentPlan.workbookPatch.mode}`);
  assert(task.agentPlan.workbookPatch.oldValue === '1.7支付杜潇报销费用', 'oldValue 解析错误');
  assert(task.agentPlan.workbookPatch.newValue === '1.7支付杜潇报销费用test', 'newValue 解析错误');
}

async function main() {
  await verifySandboxRejectsFailedResidualOutput();
  await verifyResidualOutputValidationFails();
  verifyDirectTextEditRoutesToWorkbookPatch();
  console.log('workflow guards passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

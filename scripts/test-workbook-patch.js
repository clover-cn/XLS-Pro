const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const PATCH_SCRIPT = path.join(ROOT, 'server', 'workbook_patch.py');
const WORK_DIR = path.join(ROOT, '.agentic-tasks', 'workbook-patch-smoke');
const INPUT_FILE = path.join(WORK_DIR, 'input.xlsx');
const OUTPUT_FILE = path.join(WORK_DIR, 'output.xlsx');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function runPython(args) {
  const result = spawnSync(PYTHON_BIN, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`python 失败，退出码 ${result.status}`);
  }
  return result.stdout;
}

function createWorkbook() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const code = `
from datetime import date, timedelta
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
wb = Workbook()
ws = wb.active
ws.title = "sheet1"
ws.merge_cells("A1:C1")
ws["A1"] = "基础信息"
ws["A2"] = "能力名称"
ws["B2"] = "手机号快速验证组件"
ws["A3"] = "单位"
ws["B3"] = "次"
ws["A6"] = "图表数据"
ws["A7"] = "时间"
ws["B7"] = "用量"
ws["C7"] = "摘要"
ws["A1"].font = Font(bold=True)
ws["A7"].font = Font(bold=True)
ws["B7"].font = Font(bold=True)
ws["C7"].font = Font(bold=True)
ws["B7"].fill = PatternFill("solid", fgColor="FFEEAA")
ws.column_dimensions["A"].width = 18
ws.column_dimensions["B"].width = 14
ws.column_dimensions["C"].width = 24
start = date(2025, 12, 1)
for offset in range(31):
    row = 8 + offset
    ws.cell(row=row, column=1).value = start + timedelta(days=offset)
    ws.cell(row=row, column=2).value = 100 + offset
    ws.cell(row=row, column=3).value = f"行{row}"
    if row in (16, 17):
        ws.cell(row=row, column=3).value = "1.7支付杜潇报销费用"
        ws.cell(row=row, column=3).font = Font(color="FF0000", italic=True)
wb.save(r"${INPUT_FILE.replace(/\\/g, '\\\\')}")
`;
  runPython(['-c', code]);
}

function verifyWorkbook() {
  const code = `
from openpyxl import load_workbook
wb = load_workbook(r"${OUTPUT_FILE.replace(/\\/g, '\\\\')}", data_only=False)
ws = wb["sheet1"]
changed = []
unchanged = []
for row in range(8, 39):
    value = ws.cell(row=row, column=2).value
    day = ws.cell(row=row, column=1).value.day
    if 20 <= day <= 31:
        changed.append(value)
    else:
        unchanged.append(value)
assert len(changed) == 12, len(changed)
assert all(value == 0 for value in changed), changed
assert any(value != 0 for value in unchanged), unchanged
assert ws.column_dimensions["A"].width == 18
assert ws["B7"].fill.fgColor.rgb == "00FFEEAA"
assert "A1:C1" in {str(rng) for rng in ws.merged_cells.ranges}
print("workbook patch smoke passed")
`;
  runPython(['-c', code]);
}

function verifyTextReplaceWorkbook() {
  const code = `
from openpyxl import load_workbook
wb = load_workbook(r"${OUTPUT_FILE.replace(/\\/g, '\\\\')}", data_only=False)
ws = wb["sheet1"]
assert ws["C16"].value == "1.7支付杜潇报销费用test", ws["C16"].value
assert ws["C17"].value == "1.7支付杜潇报销费用test", ws["C17"].value
assert ws["C16"].font.italic is True
assert ws.column_dimensions["C"].width == 24
assert ws.column_dimensions["A"].width == 18
assert ws["B7"].fill.fgColor.rgb == "00FFEEAA"
assert "A1:C1" in {str(rng) for rng in ws.merged_cells.ranges}
print("workbook text replace smoke passed")
`;
  runPython(['-c', code]);
}

function main() {
  createWorkbook();
  const patch = {
    mode: 'date_range_set',
    sheetName: 'sheet1',
    headerRowNumber: 7,
    conditionColumn: '时间',
    targetColumn: '用量',
    startDate: '2025-12-20',
    endDate: '2025-12-31',
    newValue: '0',
  };
  const output = runPython([PATCH_SCRIPT, INPUT_FILE, OUTPUT_FILE, JSON.stringify(patch)]);
  const payload = JSON.parse(output.trim().split(/\r?\n/).pop() || '{}');
  if (!payload.ok) throw new Error(payload.error || 'workbook_patch.py 返回失败');
  if (payload.data.changedCellCount !== 12) {
    throw new Error(`修改单元格数量不符合预期: ${payload.data.changedCellCount}`);
  }
  verifyWorkbook();

  createWorkbook();
  const textPatch = {
    mode: 'text_replace',
    sheetName: 'sheet1',
    oldValue: '1.7支付杜潇报销费用',
    newValue: '1.7支付杜潇报销费用test',
  };
  const textOutput = runPython([PATCH_SCRIPT, INPUT_FILE, OUTPUT_FILE, JSON.stringify(textPatch)]);
  const textPayload = JSON.parse(textOutput.trim().split(/\r?\n/).pop() || '{}');
  if (!textPayload.ok) throw new Error(textPayload.error || 'workbook_patch.py 返回失败');
  if (textPayload.data.changedCellCount !== 2) {
    throw new Error(`文本替换数量不符合预期: ${textPayload.data.changedCellCount}`);
  }
  verifyTextReplaceWorkbook();
}

main();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const TASK_DIR = resolveProjectPath(process.env.TASK_STORAGE_DIR || '.agentic-tasks');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const RUNNER = path.join(ROOT, 'server', 'sandbox', 'runner.py');
const TIMEOUT_SECONDS = Math.max(1, Math.ceil(Number(process.env.SANDBOX_TIMEOUT_MS || 60000) / 1000));

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

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function latestTaskId() {
  const dirs = fs.readdirSync(TASK_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(TASK_DIR, entry.name);
      return { id: entry.name, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!dirs.length) throw new Error(`没有找到任务目录: ${TASK_DIR}`);
  return dirs[0].id;
}

function findInputFile(taskDir) {
  const file = fs.readdirSync(taskDir)
    .find((name) => /\.(xlsx|csv)$/i.test(name) && !/^output/.test(name));
  if (!file) throw new Error(`任务目录里没有找到 .xlsx/.csv 源文件: ${taskDir}`);
  return path.join(taskDir, file);
}

function localSmokeCode() {
  const requirementIndex = process.argv.indexOf('--requirement');
  let requirement = '';
  if (requirementIndex >= 0) {
    const parts = [];
    for (let index = requirementIndex + 1; index < process.argv.length; index += 1) {
      if (process.argv[index].startsWith('--')) break;
      parts.push(process.argv[index]);
    }
    requirement = parts.join('');
  }
  const quoted = /[“"']([^”"']+)[”"']/.exec(requirement);
  const matchTerm = quoted ? quoted[1].trim() : '';
  if (/借方/.test(requirement) && /总和|合计|求和|汇总/.test(requirement)) {
    return localDebitSumCode(matchTerm);
  }

  return `import pandas as pd

def normalize_column(value, index):
    if pd.isna(value):
        return f"Column {index + 1}"
    text = str(value).strip()
    if not text or text.lower().startswith("unnamed"):
        return f"Column {index + 1}"
    return text

def make_unique(columns):
    seen = {}
    output = []
    for column in columns:
        count = seen.get(column, 0)
        seen[column] = count + 1
        output.append(column if count == 0 else f"{column}_{count + 1}")
    return output

def read_table(path):
    if path.lower().endswith(".csv"):
        return pd.read_csv(path)
    raw = pd.read_excel(path, header=None)
    best_index = 0
    best_score = -1
    for row_index in range(min(len(raw), 20)):
        values = [str(value).strip() for value in raw.iloc[row_index].tolist() if not pd.isna(value)]
        score = sum(1 for value in values if any(token in value for token in ["日期", "摘要", "科目", "借方", "贷方", "金额"]))
        if score > best_score:
            best_score = score
            best_index = row_index
    headers = [normalize_column(value, index) for index, value in enumerate(raw.iloc[best_index].tolist())]
    df = raw.iloc[best_index + 1:].copy()
    df.columns = make_unique(headers)
    return df.dropna(how="all").reset_index(drop=True)

df = read_table(INPUT_FILE)
debit = pd.to_numeric(df["借方"], errors="coerce").fillna(0) if "借方" in df.columns else pd.Series([0] * len(df), index=df.index)
credit = pd.to_numeric(df["贷方"], errors="coerce").fillna(0) if "贷方" in df.columns else pd.Series([0] * len(df), index=df.index)
result = df.copy()
result["AI_调整后金额"] = debit - credit
subject = result["科目"].astype(str) if "科目" in result.columns else pd.Series([""] * len(result), index=result.index)
summary_text = result["摘要"].astype(str) if "摘要" in result.columns else pd.Series([""] * len(result), index=result.index)
result["AI_现金流分类"] = "待复核"
result.loc[subject.str.contains("预付账款", na=False), "AI_现金流分类"] = "经营活动现金流出"
result.loc[summary_text.str.contains("退款", na=False), "AI_现金流分类"] = "退款调整"
summary = result.groupby("AI_现金流分类", dropna=False)["AI_调整后金额"].sum().reset_index()
with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl") as writer:
    result.to_excel(writer, sheet_name="处理明细", index=False)
    summary.to_excel(writer, sheet_name="分类汇总", index=False)
`;
}

function localDebitSumCode(matchTerm) {
  return `import pandas as pd

match_term = ${JSON.stringify(matchTerm)}

def normalize_column(value, index):
    if pd.isna(value):
        return f"Column {index + 1}"
    text = str(value).strip()
    if not text or text.lower().startswith("unnamed"):
        return f"Column {index + 1}"
    return text

def make_unique(columns):
    seen = {}
    output = []
    for column in columns:
        count = seen.get(column, 0)
        seen[column] = count + 1
        output.append(column if count == 0 else f"{column}_{count + 1}")
    return output

def read_table(path):
    if path.lower().endswith(".csv"):
        return pd.read_csv(path)
    excel = pd.ExcelFile(path)
    sheet_name = "Sheet1" if "Sheet1" in excel.sheet_names else excel.sheet_names[0]
    raw = pd.read_excel(path, sheet_name=sheet_name, header=None)
    best_index = 0
    best_score = -1
    for row_index in range(min(len(raw), 30)):
        values = [str(value).strip() for value in raw.iloc[row_index].tolist() if not pd.isna(value)]
        score = sum(1 for value in values if any(token in value for token in ["日期", "摘要", "科目", "借方", "贷方", "金额"]))
        if score > best_score:
            best_score = score
            best_index = row_index
    headers = [normalize_column(value, index) for index, value in enumerate(raw.iloc[best_index].tolist())]
    df = raw.iloc[best_index + 1:].copy()
    df.columns = make_unique(headers)
    return df.dropna(how="all").reset_index(drop=True)

df = read_table(INPUT_FILE)
if "借方" not in df.columns:
    raise KeyError(f"无法找到列 '借方'，当前列名: {list(df.columns)}")

debit = pd.to_numeric(df["借方"], errors="coerce").fillna(0)
text_columns = [column for column in df.columns if df[column].dtype == "object" or str(df[column].dtype).startswith("string")]
if match_term:
    mask = pd.Series(False, index=df.index)
    for column in text_columns:
        mask = mask | df[column].astype(str).str.contains(match_term, na=False)
else:
    mask = pd.Series(True, index=df.index)

matched = df.loc[mask].copy()
matched["AI_借方金额"] = debit.loc[mask]
summary = pd.DataFrame([
    {"匹配关键词": match_term or "全部", "匹配行数": int(mask.sum()), "借方总和": float(debit.loc[mask].sum())}
])

with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl") as writer:
    summary.to_excel(writer, sheet_name="借方汇总", index=False)
    matched.to_excel(writer, sheet_name="匹配明细", index=False)
`;
}

function main() {
  const args = process.argv.slice(2);
  const taskId = !args[0] || args[0] === 'latest' ? latestTaskId() : args[0];
  const useLocal = args.includes('--local');
  const taskDir = path.join(TASK_DIR, taskId);
  if (!fs.existsSync(taskDir)) throw new Error(`任务不存在: ${taskId}`);

  const inputFile = findInputFile(taskDir);
  const scriptFile = useLocal ? path.join(taskDir, 'local-smoke.py') : path.join(taskDir, 'generated.py');
  const outputFile = path.join(taskDir, useLocal ? 'output-smoke.xlsx' : 'output-rerun.xlsx');

  if (useLocal) {
    fs.writeFileSync(scriptFile, localSmokeCode(), 'utf8');
  }
  if (!fs.existsSync(scriptFile)) throw new Error(`脚本不存在: ${scriptFile}`);

  console.log(JSON.stringify({
    taskId,
    mode: useLocal ? 'local' : 'generated',
    inputFile,
    scriptFile,
    outputFile,
    python: PYTHON_BIN,
  }, null, 2));

  const result = spawnSync(PYTHON_BIN, [RUNNER, scriptFile, inputFile, outputFile, String(TIMEOUT_SECONDS)], {
    cwd: taskDir,
    encoding: 'utf8',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 0);
}

main();

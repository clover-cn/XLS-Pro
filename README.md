# AI 表格自动化本地 MVP

这个项目把默认 Vue 示例替换为一个本地端到端的 AI 表格处理工作台：

- 前端上传 `.csv` / `.xlsx`，输入核心需求和本次特例规则。
- Node BFF 先提取用户指定的前 N 行表头/结构信息、合并单元格、字段类型和总行数，召回本地规则库。
- Agent 会通过原生模型 tools 自动调用只读 Excel 工具，按需搜索关键词、读取指定行范围，再生成代码。
- Agent 在信息不足时进入澄清状态，用户回答后继续探索数据并生成代码。
- Python 沙盒执行生成的 pandas 脚本，只读取当前任务文件并输出 `output.xlsx`。

## 环境变量

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
PYTHON_BIN=C:\Path\To\python.exe
TASK_STORAGE_DIR=.agentic-tasks
SANDBOX_TIMEOUT_MS=60000
EXCEL_TOOL_TIMEOUT_MS=30000
```

`OPENAI_API_KEY` 必须配置，并且当前 `OPENAI_MODEL` / `OPENAI_BASE_URL` 必须支持 Chat Completions 原生 `tools` / `tool_calls`。系统会先让模型用只读工具探索当前表格，再生成定制 Python；如果模型不支持工具调用、工具探索失败，或返回示例/硬编码脚本，任务会失败并写入日志，不再静默改跑无关脚本。

当前机器上的 `python` 命令可能指向 WindowsApps 启动器；处理 `.xlsx` 和执行沙盒前，请配置真实的 `PYTHON_BIN`，并确保安装：

```bash
pip install pandas openpyxl
```

## 启动

```bash
pnpm run api
pnpm run serve
```

前端开发服务会把 `/api` 代理到 `http://localhost:3100`。

也可以先构建前端，再只启动 BFF，由 Node 直接托管 `dist`：

```bash
pnpm run build
pnpm run api
```

## 本地复测沙盒代码

不想每次重新上传文件时，可以直接复用 `.agentic-tasks` 里的任务目录：

```bash
pnpm run test:task -- latest
```

这会运行最近一次任务的 `generated.py`，输出 `output-rerun.xlsx`，用于验证沙盒执行，不会重新上传文件。

如果只想验证本地沙盒环境，不调用模型：

```bash
pnpm run test:task -- latest --local
```

这会生成 `local-smoke.py` 并输出 `output-smoke.xlsx`。

也可以指定任务 ID：

```bash
pnpm run test:task -- 837b9625-7722-4e8d-92fe-8eeef220b63e --local
```

带具体需求复测：

```powershell
pnpm run test:task -- latest --local --requirement '计算出Sheet1里面所有科目的"杜潇"的借方总和'
```

## 本地复测 Excel 只读工具

不调用模型，只验证 `excel_describe_workbook`、`excel_search`、`excel_read_rows`：

```bash
pnpm run test:excel-tools
```

也可以指定文件：

```bash
pnpm run test:excel-tools -- --file input.xlsx
```

## 本地规则库

规则文件位于 `data/rules.json`。MVP 使用关键词召回，不接外部向量库。规则格式：

```json
{
  "id": "cash-flow-prepayment",
  "condition": "科目 等于 预付账款",
  "action": "归入经营活动现金流出",
  "tags": ["现金流量表", "预付账款", "经营活动"]
}
```

## API 摘要

- `POST /api/tasks`：multipart 上传文件、需求和临时规则。
- `GET /api/tasks/:id/events`：SSE 任务事件流。
- `POST /api/tasks/:id/clarifications`：提交人工澄清回答。
- `GET /api/tasks/:id/code`：查看生成的 Python。
- `GET /api/tasks/:id/output`：下载结果表。
- `GET/POST/DELETE /api/rules`：管理本地规则。

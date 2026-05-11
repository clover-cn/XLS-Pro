# AI 表格自动化本地 MVP

这个项目把默认 Vue 示例替换为一个本地端到端的 AI 表格处理工作台：

- 前端上传 `.csv` / `.xlsx`，输入核心需求和本次特例规则。
- Node BFF 只提取表头、字段类型、总行数和前 3 行样本，召回本地规则库。
- Agent 在信息不足时进入澄清状态，用户回答后继续生成代码。
- Python 沙盒执行生成的 pandas 脚本，只读取当前任务文件并输出 `output.xlsx`。

## 环境变量

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
PYTHON_BIN=C:\Path\To\python.exe
TASK_STORAGE_DIR=.agentic-tasks
SANDBOX_TIMEOUT_MS=60000
```

没有 `OPENAI_API_KEY` 时，系统会使用本地兜底脚本生成器，适合先验证上传、澄清和沙盒流程。

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

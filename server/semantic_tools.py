import json
import sys
from pathlib import Path

import pandas as pd


SEPARATOR = "\u241f"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


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


def read_table(input_file, plan):
    input_path = str(input_file)
    metadata = plan.get("metadata") or {}
    header_row = int(plan.get("headerRowNumber") or metadata.get("detectedHeaderRowNumber") or 1)
    sheet_name = plan.get("sheetName") or metadata.get("sheetName")
    if input_path.lower().endswith(".csv"):
        raw = pd.read_csv(input_path, header=None, dtype=object)
    else:
        excel = pd.ExcelFile(input_path)
        if not sheet_name or sheet_name not in excel.sheet_names:
            sheet_name = excel.sheet_names[0]
        raw = pd.read_excel(input_path, sheet_name=sheet_name, header=None, dtype=object)
    header_index = max(0, header_row - 1)
    headers = [normalize_column(value, index) for index, value in enumerate(raw.iloc[header_index].tolist())]
    df = raw.iloc[header_index + 1:].copy()
    df.columns = make_unique(headers)
    df = df.dropna(how="all").reset_index(drop=True)
    return df


def choose_subject_columns(df, plan):
    requested = []
    semantic_plan = plan.get("semanticPlan") or {}
    for value in semantic_plan.get("subject_columns") or semantic_plan.get("semantic_subjects") or plan.get("semantic_subjects") or []:
        if isinstance(value, dict):
            value = value.get("column") or value.get("name")
        if value:
            requested.append(str(value))
    existing = [column for column in requested if column in df.columns]
    if existing:
        return existing[:4]
    preferred = ["摘要", "备注", "评论", "内容", "描述", "科目", "名称", "客户", "供应商", "用途"]
    candidates = []
    for column in df.columns:
        text = str(column)
        if any(token in text for token in preferred):
            candidates.append(column)
    if candidates:
        return candidates[:4]
    object_columns = [column for column in df.columns if df[column].dtype == "object"]
    return object_columns[:3]


def semantic_key(row, columns):
    parts = []
    for column in columns:
        value = row.get(column, "")
        if pd.isna(value):
            value = ""
        parts.append(str(value).strip())
    return SEPARATOR.join(parts)


def extract(input_file, output_json, plan):
    df = read_table(input_file, plan)
    columns = choose_subject_columns(df, plan)
    if not columns:
        fail("没有可用于语义判定的文本列")
    max_unique = int(plan.get("maxUnique") or 2000)
    counts = {}
    samples = {}
    for index, row in df.iterrows():
        key = semantic_key(row, columns)
        if not key.strip(SEPARATOR).strip():
            continue
        counts[key] = counts.get(key, 0) + 1
        if key not in samples:
            samples[key] = {
                "rowIndex": int(index),
                "values": {column: ("" if pd.isna(row.get(column)) else str(row.get(column))) for column in columns},
            }
    items = [
        {
            "key": key,
            "count": count,
            "sample": samples.get(key, {}),
        }
        for key, count in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:max_unique]
    ]
    payload = {
        "rowCount": int(len(df)),
        "subjectColumns": columns,
        "totalUnique": len(counts),
        "items": items,
    }
    Path(output_json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "data": payload}, ensure_ascii=False))


def main():
    if len(sys.argv) != 5:
        fail("参数错误")
    command = sys.argv[1]
    input_file = sys.argv[2]
    output_json = sys.argv[3]
    try:
      plan = json.loads(sys.argv[4] or "{}")
    except Exception as exc:
      fail(f"计划 JSON 无法解析: {exc}")
    if command == "extract":
        extract(input_file, output_json, plan)
    else:
        fail(f"未知命令: {command}")


if __name__ == "__main__":
    main()

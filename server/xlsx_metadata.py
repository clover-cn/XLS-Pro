import json
import sys
from pathlib import Path


def infer_type(values):
    filtered = [value for value in values if value not in (None, "")]
    if not filtered:
        return "empty"
    if all(isinstance(value, (int, float)) for value in filtered):
        return "number"
    if all(hasattr(value, "isoformat") for value in filtered):
        return "date"
    return "text"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: xlsx_metadata.py <file>")

    try:
        from openpyxl import load_workbook
    except Exception as exc:
        raise SystemExit(f"openpyxl 不可用，无法解析 .xlsx 元数据: {exc}")

    file_path = Path(sys.argv[1])
    workbook = load_workbook(file_path, read_only=True, data_only=True)
    sheet = workbook.active
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value or "").strip() for value in next(rows, [])]
    samples_raw = []
    scan_values = [[] for _ in headers]
    total_rows = 0

    for row in rows:
        total_rows += 1
        values = list(row)
        for index, value in enumerate(values[: len(headers)]):
            if index < len(scan_values) and len(scan_values[index]) < 50:
                scan_values[index].append(value)
        if len(samples_raw) < 3:
            samples_raw.append(values)

    samples = [
        {
            headers[index] or f"Column {index + 1}": "" if index >= len(row) or row[index] is None else str(row[index])
            for index in range(len(headers))
        }
        for row in samples_raw
    ]

    payload = {
        "fileKind": "xlsx",
        "totalRows": total_rows,
        "columns": [
            {"name": header or f"Column {index + 1}", "type": infer_type(scan_values[index])}
            for index, header in enumerate(headers)
        ],
        "samples": samples,
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()

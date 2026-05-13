import csv
import json
import sys
from pathlib import Path


MAX_READ_ROWS = 200
MAX_SEARCH_RESULTS = 50
MAX_CELL_TEXT = 200


def cell_to_text(value):
    if value is None:
        return ""
    return str(value).strip()


def trim_text(value, limit=MAX_CELL_TEXT):
    text = cell_to_text(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def read_csv_rows(file_path):
    with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.reader(handle)]


def describe_csv(file_path):
    rows = read_csv_rows(file_path)
    total_columns = max((len(row) for row in rows), default=0)
    raw_rows = [
        {"rowNumber": index + 1, "values": [trim_text(value) for value in row]}
        for index, row in enumerate(rows[:20])
    ]
    return {
        "fileKind": "csv",
        "sheetNames": ["CSV"],
        "sheets": [{
            "sheetName": "CSV",
            "totalRows": len(rows),
            "totalColumns": total_columns,
            "rawRows": raw_rows,
            "mergedCells": [],
        }],
    }


def read_csv_range(file_path, start_row, end_row):
    rows = read_csv_rows(file_path)
    return {
        "sheetName": "CSV",
        "startRow": start_row,
        "endRow": end_row,
        "rows": [
            {"rowNumber": index + 1, "values": [trim_text(value) for value in row]}
            for index, row in enumerate(rows[start_row - 1:end_row], start=start_row - 1)
        ],
    }


def search_csv(file_path, query, max_results):
    rows = read_csv_rows(file_path)
    needle = query.casefold()
    results = []
    for row_index, row in enumerate(rows, start=1):
        for column_index, value in enumerate(row, start=1):
            text = cell_to_text(value)
            if needle in text.casefold():
                results.append({
                    "sheetName": "CSV",
                    "rowNumber": row_index,
                    "columnNumber": column_index,
                    "value": trim_text(text),
                })
                if len(results) >= max_results:
                    return results
    return results


def load_workbook(file_path, read_only=True):
    try:
        from openpyxl import load_workbook as openpyxl_load_workbook
    except Exception as exc:
        fail(f"openpyxl 不可用，无法读取 .xlsx: {exc}")
    return openpyxl_load_workbook(file_path, read_only=read_only, data_only=True)


def describe_xlsx(file_path, sheet_name=None):
    workbook = load_workbook(file_path, read_only=False)
    names = workbook.sheetnames
    selected_names = [sheet_name] if sheet_name else names
    sheets = []
    for name in selected_names:
        if name not in names:
            fail(f"工作表不存在: {name}")
        sheet = workbook[name]
        raw_rows = []
        max_row = sheet.max_row or 0
        max_column = sheet.max_column or 0
        for row_number in range(1, min(max_row, 20) + 1):
            raw_rows.append({
                "rowNumber": row_number,
                "values": [
                    trim_text(sheet.cell(row=row_number, column=column).value)
                    for column in range(1, max_column + 1)
                ],
            })
        merged_cells = [
            {
                "range": str(merged_range),
                "value": trim_text(sheet.cell(row=merged_range.min_row, column=merged_range.min_col).value),
            }
            for merged_range in sheet.merged_cells.ranges
            if merged_range.min_row <= 20
        ]
        sheets.append({
            "sheetName": name,
            "totalRows": max_row,
            "totalColumns": max_column,
            "rawRows": raw_rows,
            "mergedCells": merged_cells,
        })
    return {"fileKind": "xlsx", "sheetNames": names, "sheets": sheets}


def read_xlsx_range(file_path, sheet_name, start_row, end_row):
    workbook = load_workbook(file_path, read_only=True)
    name = sheet_name or workbook.sheetnames[0]
    if name not in workbook.sheetnames:
        fail(f"工作表不存在: {name}")
    sheet = workbook[name]
    max_column = sheet.max_column or 0
    rows = []
    for row_number in range(start_row, end_row + 1):
        rows.append({
            "rowNumber": row_number,
            "values": [
                trim_text(sheet.cell(row=row_number, column=column).value)
                for column in range(1, max_column + 1)
            ],
        })
    return {"sheetName": name, "startRow": start_row, "endRow": end_row, "rows": rows}


def search_xlsx(file_path, query, sheet_name, max_results):
    workbook = load_workbook(file_path, read_only=True)
    names = [sheet_name] if sheet_name else workbook.sheetnames
    needle = query.casefold()
    results = []
    for name in names:
        if name not in workbook.sheetnames:
            fail(f"工作表不存在: {name}")
        sheet = workbook[name]
        for row in sheet.iter_rows():
            for cell in row:
                text = cell_to_text(cell.value)
                if needle in text.casefold():
                    results.append({
                        "sheetName": name,
                        "rowNumber": cell.row,
                        "columnNumber": cell.column,
                        "value": trim_text(text),
                    })
                    if len(results) >= max_results:
                        return results
    return results


def normalized_rows_range(arguments):
    start_row = int(arguments.get("startRow", 1))
    end_row = int(arguments.get("endRow", start_row))
    if start_row < 1 or end_row < start_row:
        fail("行号必须是 1-based，且 endRow 不能小于 startRow")
    if end_row - start_row + 1 > MAX_READ_ROWS:
        fail(f"单次最多读取 {MAX_READ_ROWS} 行")
    return start_row, end_row


def main():
    if len(sys.argv) != 4:
        fail("usage: excel_tools.py <file> <tool_name> <json_arguments>")

    file_path = Path(sys.argv[1]).resolve()
    tool_name = sys.argv[2]
    try:
        arguments = json.loads(sys.argv[3] or "{}")
    except json.JSONDecodeError as exc:
        fail(f"工具参数不是合法 JSON: {exc}")

    if not file_path.is_file():
        fail("源文件不存在")

    ext = file_path.suffix.lower()
    sheet_name = arguments.get("sheetName") or None
    try:
        if tool_name == "excel_describe_workbook":
            data = describe_csv(file_path) if ext == ".csv" else describe_xlsx(file_path, sheet_name)
        elif tool_name == "excel_read_rows":
            start_row, end_row = normalized_rows_range(arguments)
            data = read_csv_range(file_path, start_row, end_row) if ext == ".csv" else read_xlsx_range(file_path, sheet_name, start_row, end_row)
        elif tool_name == "excel_search":
            query = cell_to_text(arguments.get("query"))
            if not query:
                fail("搜索关键词不能为空")
            max_results = max(1, min(int(arguments.get("maxResults", 20)), MAX_SEARCH_RESULTS))
            results = search_csv(file_path, query, max_results) if ext == ".csv" else search_xlsx(file_path, query, sheet_name, max_results)
            data = {"query": query, "resultCount": len(results), "results": results}
        else:
            fail(f"未知 Excel 工具: {tool_name}")
    except Exception as exc:
        fail(str(exc))

    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    main()

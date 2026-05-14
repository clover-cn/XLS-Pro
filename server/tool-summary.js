function summarizeToolArgs(args) {
  return {
    sheetName: args.sheetName || '',
    query: args.query || '',
    column: args.column || '',
    groupBy: args.groupBy || '',
    operation: args.operation || '',
    mode: args.mode || '',
    count: args.count || undefined,
    maxResults: args.maxResults || undefined,
    startRow: args.startRow || undefined,
    endRow: args.endRow || undefined,
  };
}

function summarizeToolResult(result) {
  const data = result && result.data ? result.data : result;
  if (!data) return {};
  if (Array.isArray(data.sheets)) {
    return {
      fileKind: data.fileKind,
      sheetNames: data.sheetNames || [],
      sheets: data.sheets.map((sheet) => ({
        sheetName: sheet.sheetName,
        totalRows: sheet.totalRows,
        totalColumns: sheet.totalColumns,
        previewRows: Array.isArray(sheet.rawRows) ? sheet.rawRows.length : 0,
        mergedCells: Array.isArray(sheet.mergedCells) ? sheet.mergedCells.length : 0,
      })),
    };
  }
  if (Array.isArray(data.columns)) {
    return {
      sheetName: data.sheetName,
      totalRows: data.totalRows,
      totalColumns: data.totalColumns,
      detectedHeaderRowNumber: data.detectedHeaderRowNumber,
      columns: data.columns.slice(0, 30),
    };
  }
  if (Array.isArray(data.results)) {
    return {
      query: data.query,
      resultCount: data.resultCount,
      sample: data.results.slice(0, 5),
    };
  }
  if (Array.isArray(data.rows)) {
    return {
      sheetName: data.sheetName,
      startRow: data.startRow,
      endRow: data.endRow,
      rowCount: data.rows.length,
      matchedRows: data.matchedRows,
      sample: data.rows.slice(0, 3),
    };
  }
  if (Array.isArray(data.topValues)) {
    return {
      sheetName: data.sheetName,
      column: data.column,
      totalRows: data.totalRows,
      nonEmptyRows: data.nonEmptyRows,
      distinctCount: data.distinctCount,
      numericCount: data.numericCount,
      numericMin: data.numericMin,
      numericMax: data.numericMax,
      topValues: data.topValues.slice(0, 10),
    };
  }
  return data;
}

function compactText(value, limit = 120) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function compactRow(row, maxCells = 40) {
  const values = Array.isArray(row.values) ? row.values : [];
  return {
    rowNumber: row.rowNumber,
    values: values.slice(0, maxCells).map((value) => compactText(value, 80)),
    omittedCells: Math.max(0, values.length - maxCells),
  };
}

function compactColumn(column) {
  return {
    index: column.index,
    storageName: column.storageName,
    name: compactText(column.name, 80),
    type: column.type,
  };
}

function compactToolContentForModel(result, toolName) {
  const data = result && result.data ? result.data : result;
  if (!data) return {};
  if (data.ok === false || data.skipped) return data;
  if (Array.isArray(data.sheets)) {
    return {
      toolName,
      sheetNames: data.sheetNames || [],
      sheets: data.sheets.map((sheet) => ({
        sheetName: sheet.sheetName,
        totalRows: sheet.totalRows,
        totalColumns: sheet.totalColumns,
        detectedHeaderRowNumber: sheet.detectedHeaderRowNumber,
      })),
    };
  }
  if (Array.isArray(data.columns)) {
    return {
      toolName,
      sheetName: data.sheetName,
      totalRows: data.totalRows,
      totalColumns: data.totalColumns,
      detectedHeaderRowNumber: data.detectedHeaderRowNumber,
      columns: data.columns.slice(0, 40).map(compactColumn),
      omittedColumns: Math.max(0, data.columns.length - 40),
      rawRows: (data.rawRows || []).slice(0, 6).map((row) => compactRow(row, 24)),
    };
  }
  if (Array.isArray(data.results)) {
    return {
      toolName,
      query: data.query,
      resultCount: data.resultCount,
      results: data.results.slice(0, 10).map((item) => ({
        sheetName: item.sheetName,
        rowNumber: item.rowNumber,
        columnNumber: item.columnNumber,
        columnName: compactText(item.columnName, 80),
        value: compactText(item.value, 120),
      })),
      omittedResults: Math.max(0, data.results.length - 10),
    };
  }
  if (Array.isArray(data.rows)) {
    const rowPayload = data.rows.some((row) => Array.isArray(row.values) || row.rowNumber !== undefined);
    if (!rowPayload) {
      return {
        toolName,
        sheetName: data.sheetName,
        operation: data.operation,
        column: data.column,
        groupBy: data.groupBy,
        rowCount: data.rows.length,
        rows: data.rows.slice(0, 50),
        omittedRows: Math.max(0, data.rows.length - 50),
      };
    }
    return {
      toolName,
      sheetName: data.sheetName,
      startRow: data.startRow,
      endRow: data.endRow,
      rowCount: data.rows.length,
      matchedRows: data.matchedRows,
      rows: data.rows.slice(0, 5).map((row) => compactRow(row, 40)),
      omittedRows: Math.max(0, data.rows.length - 5),
    };
  }
  if (Array.isArray(data.topValues)) {
    return {
      toolName,
      sheetName: data.sheetName,
      column: data.column,
      totalRows: data.totalRows,
      nonEmptyRows: data.nonEmptyRows,
      distinctCount: data.distinctCount,
      numericCount: data.numericCount,
      numericMin: data.numericMin,
      numericMax: data.numericMax,
      topValues: data.topValues.slice(0, 15).map((item) => ({
        value: compactText(item.value, 120),
        count: item.count,
      })),
    };
  }
  return summarizeToolResult(data);
}

module.exports = {
  summarizeToolArgs,
  summarizeToolResult,
  compactText,
  compactRow,
  compactColumn,
  compactToolContentForModel,
};

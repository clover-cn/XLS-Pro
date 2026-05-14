const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function inferType(values) {
  const filtered = values.filter((value) => value !== '');
  if (!filtered.length) return 'empty';
  if (filtered.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return 'number';
  if (filtered.every((value) => !Number.isNaN(Date.parse(value)))) return 'date';
  return 'text';
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function extractCsvMetadata(filePath, previewRows = 3) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const rawRows = lines.slice(0, previewRows).map((line, index) => ({
    rowNumber: index + 1,
    values: parseCsvLine(line),
  }));
  const headerIndex = rawRows.length > 1
    ? rawRows.reduce((best, row, index) => (row.values.filter(Boolean).length > rawRows[best].values.filter(Boolean).length ? index : best), 0)
    : 0;
  const headers = rawRows[headerIndex]?.values || parseCsvLine(lines[0] || '');
  const rows = lines.slice(1).map(parseCsvLine);
  return {
    fileKind: 'csv',
    sheetName: 'CSV',
    sheetNames: ['CSV'],
    totalRows: rows.length,
    totalColumns: headers.length,
    previewRows,
    rawRows,
    mergedCells: [],
    detectedHeaderRowNumber: headerIndex + 1,
    columns: headers.map((header, index) => ({
      name: header || `Column ${index + 1}`,
      type: inferType(rows.slice(0, 50).map((row) => row[index] || '')),
    })),
  };
}

function extractXlsxMetadata(filePath, previewRows = 3) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN || 'python';
    const script = path.join(__dirname, 'xlsx_metadata.py');
    const child = spawn(python, [script, filePath, String(previewRows)], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || 'XLSX 元数据解析失败'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function extractMetadata(filePath, filename, previewRows = 3) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') return extractCsvMetadata(filePath, previewRows);
  if (ext === '.xlsx') return extractXlsxMetadata(filePath, previewRows);
  throw new Error('仅支持 .csv 和 .xlsx 文件');
}

module.exports = {
  extractMetadata,
  extractCsvMetadata,
  extractXlsxMetadata,
};

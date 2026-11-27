import { parseNumberValue } from './validator.js';

export interface SimpleTableData {
  name: string;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface ReconcileColumnPair {
  leftCol: string;
  rightCol: string;
}

export interface ReconcileOptions {
  leftKeyCol: string;
  rightKeyCol: string;
  comparePairs: ReconcileColumnPair[];
  /** Numeric tolerance (e.g. 0.05 allows ±0.05 rounding differences to pass) */
  numericTolerance?: number;
}

export interface FieldDiffDetail {
  leftCol: string;
  rightCol: string;
  leftVal: string;
  rightVal: string;
  numericDelta?: number;
}

export type ReconcileStatus = 'matched' | 'mismatch' | 'onlyInLeft' | 'onlyInRight';

export interface ReconcileRowResult {
  key: string;
  status: ReconcileStatus;
  leftRow?: Record<string, string>;
  rightRow?: Record<string, string>;
  diffs: FieldDiffDetail[];
}

export interface ReconcileSummary {
  leftName: string;
  rightName: string;
  totalLeft: number;
  totalRight: number;
  matchedCount: number;
  mismatchCount: number;
  onlyInLeftCount: number;
  onlyInRightCount: number;
  results: ReconcileRowResult[];
}

function normalizeKey(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u200B-\u200F\uFEFF\u00A0\s]+/g, '')
    .toLowerCase();
}

function normalizeCell(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, '')
    .trim();
}

/**
 * Lightweight RFC-4180 CSV / Excel-clipboard TSV parser (zero dependencies).
 * Automatically detects tab-separated clipboard pastes from Excel/WPS vs comma-separated CSV.
 */
export function parseDelimitedTable(text: string, tableName = '外部表格'): SimpleTableData {
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) return { name: tableName, headers: [], rows: [] };

  const firstLine = cleanText.split(/\r?\n/)[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = tabCount >= commaCount && tabCount > 0 ? '\t' : ',';

  const matrix: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        matrix.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        matrix.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    matrix.push(row);
  }

  const nonEmpty = matrix.filter((r) => r.some((cell) => cell !== ''));
  if (nonEmpty.length === 0) return { name: tableName, headers: [], rows: [] };

  const headers = nonEmpty[0].map((h, idx) => h || `列${idx + 1}`);
  const rows = nonEmpty.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    return obj;
  });

  return { name: tableName, headers, rows };
}

/** Heuristic column matcher for auto-suggesting key & compare columns across two differently named tables */
export function suggestReconcileMapping(
  leftHeaders: string[],
  rightHeaders: string[]
): { leftKeyCol: string; rightKeyCol: string; comparePairs: ReconcileColumnPair[] } {
  const synonymGroups = [
    /订单|单号|编号|流水|发票号|order|id|code|no/i,
    /名称|姓名|商品|品名|供应商|商户|客户|name|vendor|item/i,
    /金额|总价|合计|实付|小计|total|amount|sum/i,
    /单价|价格|price/i,
    /数量|件数|qty|count/i,
    /日期|时间|date|time/i,
    /状态|status/i,
  ];

  const pairs: ReconcileColumnPair[] = [];
  const usedRight = new Set<string>();

  for (const lh of leftHeaders) {
    // 1. Exact or case-insensitive match
    const exact = rightHeaders.find(
      (rh) => !usedRight.has(rh) && rh.trim().toLowerCase() === lh.trim().toLowerCase()
    );
    if (exact) {
      pairs.push({ leftCol: lh, rightCol: exact });
      usedRight.add(exact);
      continue;
    }
    // 2. Substring overlap
    const sub = rightHeaders.find(
      (rh) =>
        !usedRight.has(rh) &&
        lh.length >= 2 &&
        rh.length >= 2 &&
        (lh.includes(rh) || rh.includes(lh))
    );
    if (sub) {
      pairs.push({ leftCol: lh, rightCol: sub });
      usedRight.add(sub);
      continue;
    }
    // 3. Semantic synonym group
    const group = synonymGroups.find((re) => re.test(lh));
    if (group) {
      const sem = rightHeaders.find((rh) => !usedRight.has(rh) && group.test(rh));
      if (sem) {
        pairs.push({ leftCol: lh, rightCol: sem });
        usedRight.add(sem);
      }
    }
  }

  // Pick best key column (prefer ID/order/name pair)
  const keyPair =
    pairs.find((p) => /订单|单号|编号|流水|发票|id|no/i.test(p.leftCol)) ||
    pairs.find((p) => /商品|品名|供应商|商户|姓名|名称|name/i.test(p.leftCol)) ||
    pairs[0];

  const leftKeyCol = keyPair?.leftCol || leftHeaders[0] || '';
  const rightKeyCol = keyPair?.rightCol || rightHeaders[0] || '';
  const comparePairs = pairs.filter((p) => p.leftCol !== leftKeyCol || p.rightCol !== rightKeyCol);

  return { leftKeyCol, rightKeyCol, comparePairs };
}

export function reconcileTables(
  left: SimpleTableData,
  right: SimpleTableData,
  options: ReconcileOptions
): ReconcileSummary {
  const tolerance = typeof options.numericTolerance === 'number' ? Math.max(0, options.numericTolerance) : 0.01;

  // Group rows by normalized key (handles duplicates safely by pairing in order)
  const rightBuckets = new Map<string, Array<Record<string, string>>>();
  for (const rRow of right.rows) {
    const rawKey = rRow[options.rightKeyCol] ?? '';
    const norm = normalizeKey(rawKey);
    if (!norm) continue;
    const list = rightBuckets.get(norm) || [];
    list.push(rRow);
    rightBuckets.set(norm, list);
  }

  const results: ReconcileRowResult[] = [];
  let matchedCount = 0;
  let mismatchCount = 0;
  let onlyInLeftCount = 0;
  let onlyInRightCount = 0;

  for (const lRow of left.rows) {
    const rawKey = lRow[options.leftKeyCol] ?? '';
    const norm = normalizeKey(rawKey);
    const bucket = norm ? rightBuckets.get(norm) : undefined;
    const rRow = bucket && bucket.length > 0 ? bucket.shift() : undefined;

    if (!rRow) {
      onlyInLeftCount++;
      results.push({
        key: rawKey || '（空主键）',
        status: 'onlyInLeft',
        leftRow: lRow,
        diffs: [],
      });
      continue;
    }

    const diffs: FieldDiffDetail[] = [];
    for (const pair of options.comparePairs) {
      const lv = normalizeCell(lRow[pair.leftCol] ?? '');
      const rv = normalizeCell(rRow[pair.rightCol] ?? '');
      if (lv === rv) continue;

      const ln = parseNumberValue(lv).value;
      const rn = parseNumberValue(rv).value;
      if (ln !== null && rn !== null) {
        const delta = Number((ln - rn).toFixed(2));
        if (Math.abs(delta) <= tolerance) {
          continue;
        }
        diffs.push({
          leftCol: pair.leftCol,
          rightCol: pair.rightCol,
          leftVal: lv,
          rightVal: rv,
          numericDelta: delta,
        });
      } else {
        diffs.push({
          leftCol: pair.leftCol,
          rightCol: pair.rightCol,
          leftVal: lv || '（空）',
          rightVal: rv || '（空）',
        });
      }
    }

    if (diffs.length === 0) {
      matchedCount++;
      results.push({
        key: rawKey,
        status: 'matched',
        leftRow: lRow,
        rightRow: rRow,
        diffs: [],
      });
    } else {
      mismatchCount++;
      results.push({
        key: rawKey,
        status: 'mismatch',
        leftRow: lRow,
        rightRow: rRow,
        diffs,
      });
    }
  }

  // Remaining unmatched rows in right table
  for (const [, remaining] of rightBuckets.entries()) {
    for (const rRow of remaining) {
      onlyInRightCount++;
      results.push({
        key: rRow[options.rightKeyCol] || '（空主键）',
        status: 'onlyInRight',
        rightRow: rRow,
        diffs: [],
      });
    }
  }

  return {
    leftName: left.name,
    rightName: right.name,
    totalLeft: left.rows.length,
    totalRight: right.rows.length,
    matchedCount,
    mismatchCount,
    onlyInLeftCount,
    onlyInRightCount,
    results,
  };
}

function escapeCsvCell(val: string): string {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const STATUS_ZH: Record<ReconcileStatus, string> = {
  matched: '完全一致',
  mismatch: '存在差异',
  onlyInLeft: '仅左表有（右表缺失）',
  onlyInRight: '仅右表有（左表缺失）',
};

/** Exports reconciliation diff report as UTF-8 BOM CSV (opens cleanly in Excel & WPS without garbled Chinese) */
export function buildReconcileCsvReport(summary: ReconcileSummary): string {
  const lines: string[] = [];
  lines.push(['对账主键', '对账状态', '差异明细'].map(escapeCsvCell).join(','));

  for (const item of summary.results) {
    const diffDesc =
      item.diffs.length > 0
        ? item.diffs
            .map((d) => {
              const deltaTxt =
                typeof d.numericDelta === 'number'
                  ? `（差额 ${d.numericDelta > 0 ? '+' : ''}${d.numericDelta}）`
                  : '';
              return `${d.leftCol}: ${d.leftVal} vs ${d.rightCol}: ${d.rightVal}${deltaTxt}`;
            })
            .join('；')
        : item.status === 'matched'
          ? '无差异'
          : STATUS_ZH[item.status];

    lines.push([item.key, STATUS_ZH[item.status], diffDesc].map(escapeCsvCell).join(','));
  }

  return '\uFEFF' + lines.join('\r\n');
}

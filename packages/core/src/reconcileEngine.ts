import { normalizeDateValue, parseNumberValue } from './validator.js';
import { toHalfWidth } from './cleanEngine.js';

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
  /** Tolerant mode ignores full-width/half-width, date format variants, and bracketed notes on keys */
  tolerantMode?: boolean;
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

export interface AmountSummary {
  leftCol: string;
  rightCol: string;
  leftTotal: number;
  rightTotal: number;
  netDelta: number;
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
  duplicateKeysDetected: boolean;
  amountSummary?: AmountSummary;
  results: ReconcileRowResult[];
}

function stripBrackets(s: string): string {
  return s.replace(/[（(【\[][^（）()【\]\[]*[）)】\]]/g, '');
}

function normalizeKey(raw: string, tolerant: boolean): string {
  let s = toHalfWidth(String(raw ?? '')).replace(/[\u200B-\u200F\uFEFF\u00A0]/g, ' ');
  if (tolerant) {
    s = stripBrackets(s);
  }
  return s.replace(/\s+/g, '').toLowerCase();
}

function normalizeCell(raw: string, tolerant: boolean): string {
  let s = String(raw ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, '')
    .trim();
  if (tolerant) {
    s = toHalfWidth(s).replace(/\s+/g, ' ').trim();
  }
  return s;
}

/** Parses numbers including accounting negatives like "(100.50)" and percentages like "12%" */
function parseReconcileNumber(raw: string): number | null {
  const s = toHalfWidth(raw).trim();
  if (!s) return null;
  const acct = s.match(/^\(([¥￥$\s,\d.]+)\)$/);
  if (acct) {
    const pos = parseNumberValue(acct[1]).value;
    return pos !== null ? -pos : null;
  }
  if (/^-?\d+(?:\.\d+)?%$/.test(s)) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Number((n / 100).toFixed(6)) : null;
  }
  return parseNumberValue(s).value;
}

function comparePairValues(
  leftRaw: string,
  rightRaw: string,
  tolerance: number,
  tolerant: boolean
): { equal: boolean; delta?: number } {
  const lv = normalizeCell(leftRaw, tolerant);
  const rv = normalizeCell(rightRaw, tolerant);
  if (lv === rv) return { equal: true };

  // Compare dates canonically if both parse to valid YYYY-MM-DD
  if (tolerant) {
    const ld = normalizeDateValue(lv);
    const rd = normalizeDateValue(rv);
    if (ld.value && rd.value && !ld.warning && !rd.warning) {
      if (ld.value === rd.value) return { equal: true };
    }
  }

  // Compare numbers with 4-decimal precision (avoids swallowing 0.123 vs 0.124 when tolerance=0)
  const ln = parseReconcileNumber(lv);
  const rn = parseReconcileNumber(rv);
  if (ln !== null && rn !== null) {
    const delta = Number((ln - rn).toFixed(4));
    if (Math.abs(delta) <= tolerance) {
      return { equal: true };
    }
    return { equal: false, delta };
  }

  return { equal: false };
}

/**
 * Lightweight RFC-4180 CSV / Excel-clipboard TSV parser (zero dependencies).
 * - Automatically detects TSV vs CSV.
 * - Auto-skips leading ERP/Alipay metadata/title rows before the real multi-column header.
 * - Deduplicates repeated column headers with `_2` suffix.
 */
export function parseDelimitedTable(text: string, tableName = '外部表格'): SimpleTableData {
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) return { name: tableName, headers: [], rows: [] };

  const previewLines = cleanText.split(/\r?\n/).slice(0, 12);
  let tabScore = 0;
  let commaScore = 0;
  for (const l of previewLines) {
    tabScore += (l.match(/\t/g) || []).length;
    commaScore += (l.match(/,/g) || []).length;
  }
  const delimiter = tabScore >= commaScore && tabScore > 0 ? '\t' : ',';

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

  // Find the first dense row as header (skips ERP/Alipay export preface lines with 1-2 cells)
  const maxCols = Math.max(...nonEmpty.slice(0, 15).map((r) => r.filter(Boolean).length));
  let headerIdx = 0;
  if (maxCols >= 3) {
    const found = nonEmpty.slice(0, 15).findIndex((r) => r.filter(Boolean).length >= Math.min(3, maxCols));
    if (found !== -1) headerIdx = found;
  }

  const seenHeaders = new Map<string, number>();
  const headers = nonEmpty[headerIdx].map((h, idx) => {
    const base = h || `列${idx + 1}`;
    const cnt = seenHeaders.get(base) || 0;
    seenHeaders.set(base, cnt + 1);
    return cnt === 0 ? base : `${base}_${cnt + 1}`;
  });

  const rows = nonEmpty.slice(headerIdx + 1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    return obj;
  });

  return { name: tableName, headers, rows };
}

/** Heuristic column matcher with HR / Finance / E-commerce synonym groups */
export function suggestReconcileMapping(
  leftHeaders: string[],
  rightHeaders: string[]
): { leftKeyCol: string; rightKeyCol: string; comparePairs: ReconcileColumnPair[] } {
  const synonymGroups = [
    /订单|单号|编号|流水|发票号|order|id|code|no/i,
    /手机|电话|联系电话|联系方式|mobile|phone|tel/i,
    /岗位|职位|应聘岗位|职务|role|position|title/i,
    /学历|最高学历|教育|degree|education/i,
    /商品|品名|产品|sku|货品|item|product/i,
    /供应商|商户|客户|公司|收款方|抬头|vendor|merchant|company/i,
    /姓名|候选人|员工|联系人|name/i,
    /金额|总价|合计|实付|总额|小计|total|amount|sum/i,
    /单价|价格|price/i,
    /数量|件数|采购件数|qty|count/i,
    /日期|时间|date|time/i,
    /状态|status/i,
  ];

  const pairs: ReconcileColumnPair[] = [];
  const usedRight = new Set<string>();

  for (const lh of leftHeaders) {
    const exact = rightHeaders.find(
      (rh) => !usedRight.has(rh) && rh.trim().toLowerCase() === lh.trim().toLowerCase()
    );
    if (exact) {
      pairs.push({ leftCol: lh, rightCol: exact });
      usedRight.add(exact);
      continue;
    }
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
    const group = synonymGroups.find((re) => re.test(lh));
    if (group) {
      const sem = rightHeaders.find((rh) => !usedRight.has(rh) && group.test(rh));
      if (sem) {
        pairs.push({ leftCol: lh, rightCol: sem });
        usedRight.add(sem);
      }
    }
  }

  const keyPair =
    pairs.find((p) => /订单|单号|编号|流水|发票|id|no/i.test(p.leftCol)) ||
    pairs.find((p) => /姓名|候选人|供应商|商户|客户|品名|商品|name/i.test(p.leftCol)) ||
    pairs[0];

  const leftKeyCol = keyPair?.leftCol || leftHeaders[0] || '';
  const rightKeyCol = keyPair?.rightCol || rightHeaders[0] || '';
  const comparePairs = pairs.filter((p) => p.leftCol !== leftKeyCol || p.rightCol !== rightKeyCol);

  return { leftKeyCol, rightKeyCol, comparePairs };
}

function computeRowDiffs(
  lRow: Record<string, string>,
  rRow: Record<string, string>,
  comparePairs: ReconcileColumnPair[],
  tolerance: number,
  tolerant: boolean
): FieldDiffDetail[] {
  const diffs: FieldDiffDetail[] = [];
  for (const pair of comparePairs) {
    const lv = lRow[pair.leftCol] ?? '';
    const rv = rRow[pair.rightCol] ?? '';
    const cmp = comparePairValues(lv, rv, tolerance, tolerant);
    if (!cmp.equal) {
      diffs.push({
        leftCol: pair.leftCol,
        rightCol: pair.rightCol,
        leftVal: normalizeCell(lv, false) || '（空）',
        rightVal: normalizeCell(rv, false) || '（空）',
        numericDelta: cmp.delta,
      });
    }
  }
  return diffs;
}

export function reconcileTables(
  left: SimpleTableData,
  right: SimpleTableData,
  options: ReconcileOptions
): ReconcileSummary {
  const tolerance =
    typeof options.numericTolerance === 'number' ? Math.max(0, options.numericTolerance) : 0.01;
  const tolerant = options.tolerantMode !== false;

  let duplicateKeysDetected = false;
  const rightBuckets = new Map<string, Array<Record<string, string>>>();
  const emptyRightRows: Array<Record<string, string>> = [];

  for (const rRow of right.rows) {
    const rawKey = rRow[options.rightKeyCol] ?? '';
    const norm = normalizeKey(rawKey, tolerant);
    if (!norm) {
      emptyRightRows.push(rRow);
      continue;
    }
    const list = rightBuckets.get(norm) || [];
    if (list.length > 0) duplicateKeysDetected = true;
    list.push(rRow);
    rightBuckets.set(norm, list);
  }

  const seenLeftKeys = new Set<string>();
  const results: ReconcileRowResult[] = [];
  let matchedCount = 0;
  let mismatchCount = 0;
  let onlyInLeftCount = 0;
  let onlyInRightCount = 0;

  for (const lRow of left.rows) {
    const rawKey = lRow[options.leftKeyCol] ?? '';
    const norm = normalizeKey(rawKey, tolerant);
    if (norm) {
      if (seenLeftKeys.has(norm)) duplicateKeysDetected = true;
      seenLeftKeys.add(norm);
    }

    const bucket = norm ? rightBuckets.get(norm) : undefined;
    if (!bucket || bucket.length === 0) {
      onlyInLeftCount++;
      results.push({
        key: rawKey.trim() || '（空主键）',
        status: 'onlyInLeft',
        leftRow: lRow,
        diffs: [],
      });
      continue;
    }

    // Best-match selection inside bucket (prevents cross-mismatching when duplicate keys appear in different order)
    let bestIdx = 0;
    let bestDiffs = computeRowDiffs(lRow, bucket[0], options.comparePairs, tolerance, tolerant);
    for (let i = 1; i < bucket.length && bestDiffs.length > 0; i++) {
      const candidateDiffs = computeRowDiffs(lRow, bucket[i], options.comparePairs, tolerance, tolerant);
      if (candidateDiffs.length < bestDiffs.length) {
        bestIdx = i;
        bestDiffs = candidateDiffs;
      }
    }

    const rRow = bucket.splice(bestIdx, 1)[0];

    if (bestDiffs.length === 0) {
      matchedCount++;
      results.push({
        key: rawKey.trim(),
        status: 'matched',
        leftRow: lRow,
        rightRow: rRow,
        diffs: [],
      });
    } else {
      mismatchCount++;
      results.push({
        key: rawKey.trim(),
        status: 'mismatch',
        leftRow: lRow,
        rightRow: rRow,
        diffs: bestDiffs,
      });
    }
  }

  for (const [, remaining] of rightBuckets.entries()) {
    for (const rRow of remaining) {
      onlyInRightCount++;
      results.push({
        key: (rRow[options.rightKeyCol] || '').trim() || '（空主键）',
        status: 'onlyInRight',
        rightRow: rRow,
        diffs: [],
      });
    }
  }
  for (const rRow of emptyRightRows) {
    onlyInRightCount++;
    results.push({
      key: '（空主键）',
      status: 'onlyInRight',
      rightRow: rRow,
      diffs: [],
    });
  }

  // Compute top-level Amount Summary Bar if an amount pair exists
  let amountSummary: AmountSummary | undefined;
  const amountPair = options.comparePairs.find(
    (p) => /金额|总价|合计|实付|总额|小计|total|amount/i.test(p.leftCol)
  );
  if (amountPair) {
    let leftTotal = 0;
    let rightTotal = 0;
    for (const r of left.rows) {
      const n = parseReconcileNumber(r[amountPair.leftCol] ?? '');
      if (n !== null) leftTotal += n;
    }
    for (const r of right.rows) {
      const n = parseReconcileNumber(r[amountPair.rightCol] ?? '');
      if (n !== null) rightTotal += n;
    }
    leftTotal = Number(leftTotal.toFixed(2));
    rightTotal = Number(rightTotal.toFixed(2));
    amountSummary = {
      leftCol: amountPair.leftCol,
      rightCol: amountPair.rightCol,
      leftTotal,
      rightTotal,
      netDelta: Number((leftTotal - rightTotal).toFixed(2)),
    };
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
    duplicateKeysDetected,
    amountSummary,
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

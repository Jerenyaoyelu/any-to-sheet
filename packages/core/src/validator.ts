import type {
  CellStatus,
  ExtractionRawItem,
  FieldSchema,
  TableSchema,
  ValidatedCell,
  ValidatedRow,
} from './types.js';

const LOW_CONFIDENCE_THRESHOLD = 0.8;

export function parseNumberValue(raw: unknown): { value: number | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: raw };
  }
  const cleaned = String(raw)
    .replace(/[¥￥$,，\s元块]/g, '')
    .trim();
  if (!cleaned) return { value: null };
  const num = Number(cleaned);
  if (Number.isFinite(num)) {
    return { value: num };
  }
  return { value: null, warning: `无法解析为数字: "${String(raw)}"` };
}

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function normalizeDateValue(raw: unknown): { value: string | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null };
  }
  const str = String(raw).trim();
  // Match standalone YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年MM月DD日 (optional time suffix)
  const ymd = str.match(
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[\sT]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/
  );
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    if (isValidCalendarDate(y, m, d)) {
      return {
        value: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      };
    }
    return { value: str, warning: `日期数值无效，请复核: "${str}"` };
  }

  // Avoid V8 Date.parse accepting bare numbers like "5" or "12"
  if (/^\d+$/.test(str)) {
    return { value: str, warning: `日期格式非标准，请复核: "${str}"` };
  }

  // Fallback for English dates like "Nov 20, 2026"
  if (/[a-zA-Z]{3,}/.test(str)) {
    const ts = Date.parse(str);
    if (!Number.isNaN(ts)) {
      const dt = new Date(ts);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return { value: `${y}-${m}-${d}` };
    }
  }

  return { value: str, warning: `日期格式非标准，请复核: "${str}"` };
}

export function parseCheckboxValue(raw: unknown): { value: boolean; warning?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: false, warning: '未提取到勾选状态，默认为否，请确认' };
  }
  if (typeof raw === 'boolean') return { value: raw };
  if (typeof raw === 'number') return { value: raw !== 0 };
  const s = String(raw).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', '是', '对', '已勾选', '√', '✓'].includes(s)) {
    return { value: true };
  }
  if (['false', 'no', 'n', '0', '否', '错', '未勾选', '×', '✗'].includes(s)) {
    return { value: false };
  }
  return { value: false, warning: `无法明确解析勾选值 "${String(raw)}"，已设为否` };
}

function matchSingleSelect(
  raw: unknown,
  field: FieldSchema
): { value: string | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const text = String(raw).trim();
  if (!field.options || field.options.length === 0) return { value: text };

  const exact = field.options.find((o) => o.name === text);
  if (exact) return { value: exact.name };

  const ci = field.options.find((o) => o.name.toLowerCase() === text.toLowerCase());
  if (ci) return { value: ci.name };

  if (text.length >= 2) {
    const fuzzy = field.options.find(
      (o) => o.name.includes(text) || (o.name.length >= 2 && text.includes(o.name))
    );
    if (fuzzy) {
      return {
        value: fuzzy.name,
        warning: `已自动对齐单选选项 "${text}" -> "${fuzzy.name}"，请复核`,
      };
    }
  }
  return {
    value: text,
    warning: `"${text}" 不在现有选项中，写入时将尝试自动新增`,
  };
}

function matchMultiSelect(
  raw: unknown,
  field: FieldSchema
): { value: string[]; warning?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: [] };
  const arr = Array.isArray(raw)
    ? raw.map((x) => String(x).trim()).filter(Boolean)
    : String(raw)
        .split(/[,，、;；]/)
        .map((x) => x.trim())
        .filter(Boolean);

  if (!field.options || field.options.length === 0) return { value: Array.from(new Set(arr)) };

  const warnings: string[] = [];
  const mapped = arr.map((item) => {
    const exact = field.options!.find((o) => o.name === item);
    if (exact) return exact.name;

    const ci = field.options!.find((o) => o.name.toLowerCase() === item.toLowerCase());
    if (ci) return ci.name;

    if (item.length >= 2) {
      const fuzzy = field.options!.find(
        (o) => o.name.includes(item) || (o.name.length >= 2 && item.includes(o.name))
      );
      if (fuzzy) {
        warnings.push(`已模糊对齐 "${item}" -> "${fuzzy.name}"`);
        return fuzzy.name;
      }
    }
    warnings.push(`"${item}" 不在现有多选选项中`);
    return item;
  });

  return {
    value: Array.from(new Set(mapped)),
    warning: warnings.length > 0 ? warnings.join('；') : undefined,
  };
}

export function runArithmeticConsistencyCheck(
  schema: TableSchema,
  cells: Record<string, ValidatedCell>
): string[] {
  const warnings: string[] = [];
  const numFields = schema.fields.filter((f) => !f.readonly && f.type === 'number');

  const qtyField = numFields.find((f) => /数量|件数|qty|quantity|count/i.test(f.name));
  const priceField = numFields.find(
    (f) => f.id !== qtyField?.id && /单价|unit\s*price/i.test(f.name)
  );
  const totalField = numFields.find(
    (f) =>
      f.id !== qtyField?.id &&
      f.id !== priceField?.id &&
      /总价|金额|合计|小计|total|amount/i.test(f.name)
  );

  if (qtyField && priceField && totalField) {
    const qty = cells[qtyField.id]?.value;
    const price = cells[priceField.id]?.value;
    const total = cells[totalField.id]?.value;

    if (typeof qty === 'number' && typeof price === 'number' && typeof total === 'number') {
      const expected = Number((qty * price).toFixed(2));
      if (Math.abs(expected - total) > 0.05) {
        const msg = `数值校验异常：${qtyField.name}(${qty}) × ${priceField.name}(${price}) = ${expected}，但${totalField.name}为 ${total}`;
        warnings.push(msg);
        if (cells[totalField.id]) {
          cells[totalField.id].status = 'warning';
          cells[totalField.id].reason = cells[totalField.id].reason
            ? `${cells[totalField.id].reason}；${msg}`
            : msg;
        }
      }
    }
  }

  return warnings;
}

export function validateSingleCell(
  field: FieldSchema,
  rawValue: unknown,
  confidence: number
): ValidatedCell {
  let value: unknown = rawValue;
  let warning: string | undefined;

  switch (field.type) {
    case 'number': {
      const parsed = parseNumberValue(rawValue);
      value = parsed.value;
      warning = parsed.warning;
      break;
    }
    case 'date': {
      const parsed = normalizeDateValue(rawValue);
      value = parsed.value;
      warning = parsed.warning;
      break;
    }
    case 'singleSelect': {
      const parsed = matchSingleSelect(rawValue, field);
      value = parsed.value;
      warning = parsed.warning;
      break;
    }
    case 'multiSelect': {
      const parsed = matchMultiSelect(rawValue, field);
      value = parsed.value;
      warning = parsed.warning;
      break;
    }
    case 'checkbox': {
      const parsed = parseCheckboxValue(rawValue);
      value = parsed.value;
      warning = parsed.warning;
      break;
    }
    default: {
      value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
      break;
    }
  }

  let status: CellStatus = 'ok';
  const reasons: string[] = [];

  if (warning) {
    status = 'warning';
    reasons.push(warning);
  }
  if (
    field.type !== 'checkbox' &&
    (value === null || value === '' || (Array.isArray(value) && value.length === 0))
  ) {
    status = 'warning';
    reasons.push('未提取到内容，请确认是否留空');
  } else if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    status = 'warning';
    reasons.push(`AI 置信度偏低 (${Math.round(confidence * 100)}%)，建议人工复核`);
  }

  return {
    fieldId: field.id,
    fieldName: field.name,
    value,
    rawValue,
    confidence,
    status,
    reason: reasons.length > 0 ? reasons.join('；') : undefined,
  };
}

/**
 * Re-validates an edited row in the UI so edited numbers/dates/multiSelects/checkboxes
 * keep proper runtime types and recalculate arithmetic warnings cleanly.
 */
export function revalidateEditedRow(
  schema: TableSchema,
  row: ValidatedRow,
  editedFieldId: string,
  newRawValue: unknown
): ValidatedRow {
  const field = schema.fields.find((f) => f.id === editedFieldId);
  if (!field) return row;

  const updatedCells: Record<string, ValidatedCell> = {};
  for (const [fid, cell] of Object.entries(row.cells)) {
    // Strip stale arithmetic warning prefix before re-running arithmetic check
    const cleanedReason = cell.reason
      ?.split('；')
      .filter((part) => !part.startsWith('数值校验异常：'))
      .join('；');
    updatedCells[fid] = {
      ...cell,
      status: cleanedReason ? cell.status : 'ok',
      reason: cleanedReason || undefined,
    };
  }

  // Re-validate the edited cell with high user confidence (1.0)
  const revalidated = validateSingleCell(field, newRawValue, 1.0);
  if (revalidated.status === 'ok') {
    revalidated.reason = '已人工确认修改';
  }
  updatedCells[editedFieldId] = revalidated;

  const preservedNotes = row.rowWarnings.filter((w) => !w.startsWith('数值校验异常：'));
  const mathWarnings = runArithmeticConsistencyCheck(schema, updatedCells);

  return {
    ...row,
    cells: updatedCells,
    rowWarnings: [...mathWarnings, ...preservedNotes],
  };
}

/**
 * Deterministic validation & confidence highlighting layer.
 * Ensures LLM hallucinations, format drift, and math mismatches are flagged in yellow before writing.
 */
export function validateExtractionItems(
  schema: TableSchema,
  items: ExtractionRawItem[]
): ValidatedRow[] {
  const writableFields = schema.fields.filter((f) => !f.readonly && f.type !== 'unknown');

  return items.map((item, idx) => {
    const safeValues =
      item && typeof item.values === 'object' && item.values !== null ? item.values : {};
    const cells: Record<string, ValidatedCell> = {};

    for (const field of writableFields) {
      const rawValue = safeValues[field.name] ?? safeValues[field.id] ?? null;
      const confidence =
        typeof item?.confidence?.[field.name] === 'number'
          ? item.confidence[field.name]
          : rawValue === null || rawValue === ''
            ? 0.5
            : 0.9;

      cells[field.id] = validateSingleCell(field, rawValue, confidence);
    }

    const rowWarnings = runArithmeticConsistencyCheck(schema, cells);
    if (item?.notes) {
      rowWarnings.push(`AI 备注：${item.notes}`);
    }

    return {
      rowId: `row_${Date.now()}_${idx}`,
      sourceFileName: item?.sourceFileName || '未知文件',
      cells,
      rowWarnings,
    };
  });
}

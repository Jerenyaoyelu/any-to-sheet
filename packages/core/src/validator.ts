import type {
  CellStatus,
  ExtractionRawItem,
  FieldSchema,
  TableSchema,
  ValidatedCell,
  ValidatedRow,
} from './types.js';

const LOW_CONFIDENCE_THRESHOLD = 0.8;

function parseNumber(raw: unknown): { value: number | null; warning?: string } {
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

function normalizeDate(raw: unknown): { value: string | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null };
  }
  const str = String(raw).trim();
  const ymd = str.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return { value: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` };
  }
  const ts = Date.parse(str);
  if (!Number.isNaN(ts)) {
    const dt = new Date(ts);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return { value: `${y}-${m}-${d}` };
  }
  return { value: str, warning: `日期格式非标准，请复核: "${str}"` };
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

  const fuzzy = field.options.find(
    (o) => o.name.includes(text) || text.includes(o.name)
  );
  if (fuzzy) {
    return {
      value: fuzzy.name,
      warning: `已自动对齐单选选项 "${text}" -> "${fuzzy.name}"，请复核`,
    };
  }
  return {
    value: text,
    warning: `"${text}" 不在现有选项中，写入时可能需要新增选项`,
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

  if (!field.options || field.options.length === 0) return { value: arr };

  const warnings: string[] = [];
  const mapped = arr.map((item) => {
    const exact = field.options!.find((o) => o.name === item);
    if (exact) return exact.name;
    const fuzzy = field.options!.find(
      (o) => o.name.includes(item) || item.includes(o.name)
    );
    if (fuzzy) return fuzzy.name;
    warnings.push(`"${item}" 不在现有多选选项中`);
    return item;
  });

  return {
    value: Array.from(new Set(mapped)),
    warning: warnings.length > 0 ? warnings.join('；') : undefined,
  };
}

function runArithmeticConsistencyCheck(
  schema: TableSchema,
  cells: Record<string, ValidatedCell>
): string[] {
  const warnings: string[] = [];
  const numFields = schema.fields.filter((f) => f.type === 'number');

  const qtyField = numFields.find((f) => /数量|件数|qty|quantity|count/i.test(f.name));
  const priceField = numFields.find((f) => /单价|price|unit/i.test(f.name));
  const totalField = numFields.find((f) => /总价|金额|合计|小计|total|amount/i.test(f.name));

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
    const cells: Record<string, ValidatedCell> = {};

    for (const field of writableFields) {
      const rawValue = item.values[field.name] ?? item.values[field.id] ?? null;
      const confidence =
        typeof item.confidence?.[field.name] === 'number'
          ? item.confidence[field.name]
          : rawValue === null || rawValue === ''
            ? 0.5
            : 0.9;

      let value: unknown = rawValue;
      let warning: string | undefined;

      switch (field.type) {
        case 'number': {
          const parsed = parseNumber(rawValue);
          value = parsed.value;
          warning = parsed.warning;
          break;
        }
        case 'date': {
          const parsed = normalizeDate(rawValue);
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
          value = rawValue === true || rawValue === 'true' || rawValue === '是' || rawValue === 1;
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
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        status = 'warning';
        reasons.push('未提取到内容，请确认是否留空');
      } else if (confidence < LOW_CONFIDENCE_THRESHOLD) {
        status = 'warning';
        reasons.push(`AI 置信度偏低 (${Math.round(confidence * 100)}%)，建议人工复核`);
      }

      cells[field.id] = {
        fieldId: field.id,
        fieldName: field.name,
        value,
        rawValue,
        confidence,
        status,
        reason: reasons.length > 0 ? reasons.join('；') : undefined,
      };
    }

    const rowWarnings = runArithmeticConsistencyCheck(schema, cells);
    if (item.notes) {
      rowWarnings.push(`AI 备注：${item.notes}`);
    }

    return {
      rowId: `row_${Date.now()}_${idx}`,
      sourceFileName: item.sourceFileName,
      cells,
      rowWarnings,
    };
  });
}

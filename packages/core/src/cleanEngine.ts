import { normalizeDateValue, parseNumberValue } from './validator.js';
import type { FieldSchema, TableRecordRow, TableRecordUpdate } from './types.js';

export type CleanRuleStep =
  | { op: 'trim' }
  | { op: 'stripInvisible' }
  | { op: 'normalizeWhitespace' }
  | { op: 'toHalfWidth' }
  | { op: 'normalizeDate' }
  | { op: 'extractPhone' }
  | { op: 'extractNumber' }
  | { op: 'case'; mode: 'upper' | 'lower' }
  | { op: 'regexReplace'; pattern: string; flags?: string; replacement: string }
  | { op: 'regexExtract'; pattern: string; flags?: string; group?: number }
  | { op: 'splitPick'; delimiter: string; index: number }
  | { op: 'removeBrackets' }
  | { op: 'prefixSuffix'; addPrefix?: string; addSuffix?: string; stripPrefix?: string; stripSuffix?: string }
  | { op: 'valueMap'; mapping: Record<string, string>; mode?: 'exact' | 'contains' };

export interface CleanRulePlan {
  summary: string;
  steps: CleanRuleStep[];
}

export interface CleanDiffItem {
  recordId: string;
  fieldId: string;
  fieldName: string;
  before: string;
  after: string;
  typedAfter: unknown;
}

export interface CleanPreviewResult {
  totalScanned: number;
  changedCount: number;
  diffs: CleanDiffItem[];
  applyUpdates: TableRecordUpdate[];
  rollbackUpdates: TableRecordUpdate[];
}

export const BUILTIN_CLEAN_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  plan: CleanRulePlan;
}> = [
  {
    id: 'trim_clean',
    label: '去空格与隐藏字符',
    description: '清除首尾空白、零宽字符、多余连续空格',
    plan: {
      summary: '清除首尾空格、零宽不可见字符并折叠多余空白',
      steps: [{ op: 'stripInvisible' }, { op: 'normalizeWhitespace' }, { op: 'trim' }],
    },
  },
  {
    id: 'half_width',
    label: '全角转半角',
    description: '把全角数字/字母/标点统一转为标准半角',
    plan: {
      summary: '将全角字符统一转换为标准半角并去除首尾空格',
      steps: [{ op: 'stripInvisible' }, { op: 'toHalfWidth' }, { op: 'trim' }],
    },
  },
  {
    id: 'std_date',
    label: '日期统一 YYYY-MM-DD',
    description: '把 2026/1/5、2026年1月5日、2026.01.05 统一格式化',
    plan: {
      summary: '统一日期格式为标准 YYYY-MM-DD',
      steps: [{ op: 'stripInvisible' }, { op: 'toHalfWidth' }, { op: 'trim' }, { op: 'normalizeDate' }],
    },
  },
  {
    id: 'extract_phone',
    label: '提取手机号',
    description: '从混合姓名/地址文本中提取 11 位大陆手机号',
    plan: {
      summary: '提取 11 位中国大陆手机号',
      steps: [{ op: 'toHalfWidth' }, { op: 'extractPhone' }],
    },
  },
  {
    id: 'extract_number',
    label: '提取纯数字',
    description: '去掉 ¥、元、逗号和单位，保留纯数值',
    plan: {
      summary: '去除货币符号与分隔符，保留标准数字',
      steps: [{ op: 'toHalfWidth' }, { op: 'extractNumber' }],
    },
  },
  {
    id: 'remove_brackets',
    label: '去除括号备注',
    description: '清理中英文括号及括号内附注，如“公司A（待核对）”',
    plan: {
      summary: '移除中英文括号及内部备注文本',
      steps: [{ op: 'removeBrackets' }, { op: 'normalizeWhitespace' }, { op: 'trim' }],
    },
  },
];

function toHalfWidth(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += str[i];
    }
  }
  return out;
}

function safeRegExp(pattern: string, flags = 'g'): RegExp | null {
  if (!pattern || pattern.length > 200) return null;
  const safeFlags = flags.replace(/[^gimsu]/g, '');
  try {
    return new RegExp(pattern, safeFlags);
  } catch {
    return null;
  }
}

/**
 * Pure, CSP-safe declarative step executor (zero eval / zero Function constructor).
 * Safe to run inside Feishu iframe, WPS Add-in, Excel Add-in, or Node.js.
 */
export function applyCleanSteps(rawInput: string, steps: CleanRuleStep[]): string {
  let val = rawInput;

  for (const step of steps) {
    switch (step.op) {
      case 'trim':
        val = val.trim();
        break;
      case 'stripInvisible':
        val = val.replace(/[\u200B-\u200F\uFEFF\u00A0\u202A-\u202E]/g, '');
        break;
      case 'normalizeWhitespace':
        val = val.replace(/[ \t\r\n]+/g, ' ').trim();
        break;
      case 'toHalfWidth':
        val = toHalfWidth(val);
        break;
      case 'normalizeDate': {
        const res = normalizeDateValue(val);
        if (res.value) val = res.value;
        break;
      }
      case 'extractPhone': {
        const m = val.replace(/[\s-]/g, '').match(/1[3-9]\d{9}/);
        if (m) val = m[0];
        break;
      }
      case 'extractNumber': {
        const direct = parseNumberValue(val);
        if (direct.value !== null) {
          val = String(direct.value);
        } else {
          const m = val.replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
          if (m) val = m[0];
        }
        break;
      }
      case 'case':
        val = step.mode === 'upper' ? val.toUpperCase() : val.toLowerCase();
        break;
      case 'removeBrackets':
        val = val.replace(/[（(][^）)]*[）)]/g, '');
        break;
      case 'regexReplace': {
        const re = safeRegExp(step.pattern, step.flags ?? 'g');
        if (re) val = val.replace(re, step.replacement ?? '');
        break;
      }
      case 'regexExtract': {
        const re = safeRegExp(step.pattern, (step.flags ?? '').replace(/g/g, ''));
        if (re) {
          const m = val.match(re);
          if (m) {
            const idx = typeof step.group === 'number' && step.group >= 0 ? step.group : 0;
            val = m[idx] ?? m[0] ?? val;
          }
        }
        break;
      }
      case 'splitPick': {
        if (step.delimiter) {
          const parts = val.split(step.delimiter).map((s) => s.trim());
          const idx = step.index < 0 ? parts.length + step.index : step.index;
          if (idx >= 0 && idx < parts.length) {
            val = parts[idx];
          }
        }
        break;
      }
      case 'prefixSuffix': {
        if (step.stripPrefix && val.startsWith(step.stripPrefix)) {
          val = val.slice(step.stripPrefix.length);
        }
        if (step.stripSuffix && val.endsWith(step.stripSuffix)) {
          val = val.slice(0, val.length - step.stripSuffix.length);
        }
        if (step.addPrefix && !val.startsWith(step.addPrefix)) {
          val = step.addPrefix + val;
        }
        if (step.addSuffix && !val.endsWith(step.addSuffix)) {
          val = val + step.addSuffix;
        }
        break;
      }
      case 'valueMap': {
        const entries = Object.entries(step.mapping || {});
        const mode = step.mode || 'exact';
        for (const [from, to] of entries) {
          if (!from) continue;
          if (mode === 'exact' && val.trim() === from.trim()) {
            val = to;
            break;
          }
          if (mode === 'contains' && val.includes(from)) {
            val = to;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return val;
}

function coerceAfterValue(field: FieldSchema, afterText: string): unknown {
  if (field.type === 'number') {
    const parsed = parseNumberValue(afterText);
    return parsed.value !== null ? parsed.value : afterText;
  }
  if (field.type === 'multiSelect') {
    return afterText
      .split(/[,，、;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return afterText;
}

export function computeCleanDiff(
  field: FieldSchema,
  records: TableRecordRow[],
  steps: CleanRuleStep[]
): CleanPreviewResult {
  const diffs: CleanDiffItem[] = [];
  const applyUpdates: TableRecordUpdate[] = [];
  const rollbackUpdates: TableRecordUpdate[] = [];

  for (const rec of records) {
    const rawVal = rec.values[field.id];
    if (rawVal === null || rawVal === undefined) continue;
    const before = Array.isArray(rawVal) ? rawVal.join(', ') : String(rawVal);
    if (!before) continue;

    const after = applyCleanSteps(before, steps);
    if (after !== before) {
      const typedAfter = coerceAfterValue(field, after);
      diffs.push({
        recordId: rec.recordId,
        fieldId: field.id,
        fieldName: field.name,
        before,
        after,
        typedAfter,
      });
      applyUpdates.push({
        recordId: rec.recordId,
        values: { [field.id]: typedAfter },
      });
      rollbackUpdates.push({
        recordId: rec.recordId,
        values: { [field.id]: rawVal },
      });
    }
  }

  return {
    totalScanned: records.length,
    changedCount: diffs.length,
    diffs,
    applyUpdates,
    rollbackUpdates,
  };
}

export function buildCleanRulePrompt(
  fieldName: string,
  fieldType: string,
  samples: string[],
  instruction: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    '你是一个数据清洗规则编译器。',
    '根据用户提供的列名、样例数据和清洗指令，输出一个声明式的 JSON 清洗步骤数组 steps。',
    '只输出合法 JSON，不要输出任何额外解释或 Markdown。',
    '可用操作 op 清单：',
    '- {"op":"trim"}',
    '- {"op":"stripInvisible"}',
    '- {"op":"normalizeWhitespace"}',
    '- {"op":"toHalfWidth"}',
    '- {"op":"normalizeDate"} (统一输出 YYYY-MM-DD)',
    '- {"op":"extractPhone"} (提取11位手机号)',
    '- {"op":"extractNumber"} (提取纯数字)',
    '- {"op":"case","mode":"upper"|"lower"}',
    '- {"op":"removeBrackets"} (去除中英文括号及内容)',
    '- {"op":"regexReplace","pattern":"正则","flags":"g","replacement":"替换文本"}',
    '- {"op":"regexExtract","pattern":"正则","flags":"","group":1}',
    '- {"op":"splitPick","delimiter":"分隔符","index":0}',
    '- {"op":"prefixSuffix","addPrefix":"","addSuffix":"","stripPrefix":"","stripSuffix":""}',
    '- {"op":"valueMap","mapping":{"旧值":"标准值"},"mode":"exact"|"contains"}',
    '输出格式严格为：{"summary":"一句话中文说明清洗规则","steps":[...]}',
  ].join('\n');

  const userPrompt = [
    `【列名】${fieldName}（类型：${fieldType}）`,
    `【用户清洗要求】${instruction}`,
    '【当前列样例数据（最多 20 条）】',
    JSON.stringify(samples.slice(0, 20), null, 2),
    '请生成最准确、泛化能力最强的声明式清洗步骤 JSON。',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

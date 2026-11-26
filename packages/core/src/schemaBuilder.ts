import type { FieldSchema, TableSchema } from './types.js';

export interface ExtractionPromptPayload {
  systemPrompt: string;
  userPrompt: string;
  writableFields: FieldSchema[];
}

/**
 * Dynamically builds a host-agnostic extraction prompt from the user's live table schema.
 * No pre-configuration or fixed templates required.
 */
export function buildExtractionPrompt(
  schema: TableSchema,
  fileNames: string[],
  userHint?: string
): ExtractionPromptPayload {
  const writableFields = schema.fields.filter((f) => !f.readonly && f.type !== 'unknown');

  const fieldSpecs = writableFields.map((field) => {
    const spec: Record<string, unknown> = {
      name: field.name,
      type: field.type,
    };
    if (field.options && field.options.length > 0) {
      spec.allowedOptions = field.options.map((o) => o.name);
    }
    return spec;
  });

  const systemPrompt = [
    '你是一个高精度的多模态表格数据提取引擎。',
    '你的任务是从用户提供的文件（图片、截图、PDF、文档）中，严格按照目标表格的字段结构提取结构化数据。',
    '必须遵守以下规则：',
    '1. 仅输出合法的 JSON，不要包含 Markdown 代码块或任何额外解释文字。',
    '2. 如果单个文件里包含多条明细记录（例如一张报价单有多行商品、一张截图有多条账目），请拆分为多条记录输出；如果是单主体文件（如简历、发票、名片），输出 1 条记录。',
    '3. 字段值规范：',
    '   - number: 输出纯数字（去掉货币符号和逗号，如 1250.5）。',
    '   - date: 尽量统一输出 YYYY-MM-DD 格式。',
    '   - singleSelect: 优先精确匹配 allowedOptions 中的选项名称；如果没有完全匹配，给出最合理的短文本。',
    '   - multiSelect: 输出字符串数组，优先匹配 allowedOptions。',
    '   - checkbox: 输出 true 或 false。',
    '   - 找不到的字段填 null，绝对不要编造！',
    '4. 为每个提取字段评估置信度 confidence（0 到 1 之间的小数，清晰明确为 0.95，模糊或推测低于 0.75）。',
    '5. 返回 JSON 格式必须严格为：',
    '{"items":[{"sourceFileName":"文件名","values":{"字段名":值},"confidence":{"字段名":0.95},"notes":"可选补充说明"}]}',
  ].join('\n');

  const sampleText =
    schema.sampleRows.length > 0
      ? `\n\n【当前表格已有示例行（参考填写风格）】\n${JSON.stringify(schema.sampleRows.slice(0, 3), null, 2)}`
      : '';

  const hintText = userHint?.trim() ? `\n\n【用户额外说明】\n${userHint.trim()}` : '';

  const userPrompt = [
    `【目标表格名称】${schema.tableName}`,
    `【本次上传文件】${fileNames.join(', ')}`,
    '【目标字段结构】',
    JSON.stringify(fieldSpecs, null, 2),
    sampleText,
    hintText,
    '\n请根据附带的文件内容提取数据，并返回严格符合格式要求的 JSON。',
  ].join('\n');

  return {
    systemPrompt,
    userPrompt,
    writableFields,
  };
}

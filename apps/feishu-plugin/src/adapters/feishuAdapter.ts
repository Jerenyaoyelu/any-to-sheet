import {
  bitable,
  FieldType,
  type IAttachmentField,
  type IMultiSelectField,
  type IOpenAttachment,
  type IOpenCellValue,
  type IRecordValue,
  type ISingleSelectField,
} from '@lark-base-open/js-sdk';
import {
  normalizeDateValue,
  parseCheckboxValue,
  parseNumberValue,
  type AttachmentFieldInfo,
  type FieldSchema,
  type HostAdapter,
  type HostAttachmentItem,
  type NormalizedFieldType,
  type SelectOption,
  type TableSchema,
  type UserIdentity,
  type ValidatedRow,
} from '@table-ai/core';

function mapFeishuFieldType(type: FieldType): { normalized: NormalizedFieldType; readonly: boolean } {
  switch (type) {
    case FieldType.Text:
    case FieldType.Barcode:
      return { normalized: 'text', readonly: false };
    case FieldType.Number:
    case FieldType.Currency:
    case FieldType.Progress:
    case FieldType.Rating:
      return { normalized: 'number', readonly: false };
    case FieldType.SingleSelect:
      return { normalized: 'singleSelect', readonly: false };
    case FieldType.MultiSelect:
      return { normalized: 'multiSelect', readonly: false };
    case FieldType.DateTime:
      return { normalized: 'date', readonly: false };
    case FieldType.Checkbox:
      return { normalized: 'checkbox', readonly: false };
    case FieldType.Phone:
      return { normalized: 'phone', readonly: false };
    case FieldType.Url:
      return { normalized: 'url', readonly: false };
    case FieldType.Email:
      return { normalized: 'email', readonly: false };
    default:
      return { normalized: 'unknown', readonly: true };
  }
}

/** Parses YYYY-MM-DD (or localized dates) to local midnight timestamp (avoids UTC off-by-one day shift) */
function toLocalMidnightTimestamp(raw: unknown): number | undefined {
  const { value } = normalizeDateValue(raw);
  if (!value) return undefined;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

function splitMultiSelectValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(value)
    .split(/[,，、;；]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function findOption(options: SelectOption[] | undefined, rawName: string): SelectOption | undefined {
  if (!options) return undefined;
  const target = rawName.trim();
  return (
    options.find((o) => o.name === target) ||
    options.find((o) => o.name.toLowerCase() === target.toLowerCase())
  );
}

function toFeishuCellValue(
  field: FieldSchema,
  value: unknown,
  latestOptions?: SelectOption[]
): IOpenCellValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (field.type !== 'checkbox' && value === '') return undefined;

  switch (field.type) {
    case 'text':
      return [{ type: 'text', text: String(value) }] as unknown as IOpenCellValue;
    case 'email':
    case 'phone':
      // Per @lark-base-open/js-sdk, Email (99005) and Phone (13) expect plain strings
      return String(value).trim() as unknown as IOpenCellValue;
    case 'url': {
      const rawLink = String(value).trim();
      const link = /^https?:\/\//i.test(rawLink) ? rawLink : `https://${rawLink}`;
      return [{ type: 'url', text: rawLink, link }] as unknown as IOpenCellValue;
    }
    case 'number': {
      const { value: n } = parseNumberValue(value);
      return n !== null ? (n as unknown as IOpenCellValue) : undefined;
    }
    case 'date': {
      const ts = toLocalMidnightTimestamp(value);
      return ts !== undefined ? (ts as unknown as IOpenCellValue) : undefined;
    }
    case 'checkbox': {
      const { value: boolVal } = parseCheckboxValue(value);
      return boolVal as unknown as IOpenCellValue;
    }
    case 'singleSelect': {
      const matched = findOption(latestOptions || field.options, String(value));
      if (matched) {
        return { id: matched.id, text: matched.name } as unknown as IOpenCellValue;
      }
      return undefined;
    }
    case 'multiSelect': {
      const items = splitMultiSelectValues(value);
      const opts = latestOptions || field.options;
      const matched = items
        .map((name) => findOption(opts, name))
        .filter((o): o is SelectOption => Boolean(o))
        .map((o) => ({ id: o.id, text: o.name }));
      return matched.length > 0 ? (matched as unknown as IOpenCellValue) : undefined;
    }
    default:
      return undefined;
  }
}

export class FeishuHostAdapter implements HostAdapter {
  readonly hostName = '飞书多维表格';

  async getUserIdentity(): Promise<UserIdentity> {
    let userId = '';
    let tenantKey: string | undefined;
    try {
      userId = await bitable.bridge.getBaseUserId();
    } catch {
      // fallback below
    }
    try {
      tenantKey = await bitable.bridge.getTenantKey();
    } catch {
      // optional
    }
    if (!userId) {
      const storageKey = 'any_to_sheet_feishu_fallback_uid';
      let cached = window.localStorage.getItem(storageKey);
      if (!cached) {
        cached = `feishu_local_${Math.random().toString(36).slice(2, 10)}`;
        window.localStorage.setItem(storageKey, cached);
      }
      userId = cached;
    } else {
      userId = `fs_${userId}`;
    }
    return { userId, tenantKey };
  }

  async getActiveTableSchema(): Promise<TableSchema> {
    const table = await bitable.base.getActiveTable();
    const tableName = await table.getName();
    const selection = await bitable.base.getSelection();

    let fieldMetaList;
    if (selection.viewId) {
      try {
        const view = await table.getViewById(selection.viewId);
        fieldMetaList = await view.getFieldMetaList();
      } catch {
        fieldMetaList = await table.getFieldMetaList();
      }
    } else {
      fieldMetaList = await table.getFieldMetaList();
    }

    const attachmentFields: AttachmentFieldInfo[] = [];

    const fields: FieldSchema[] = fieldMetaList.map((meta) => {
      if (meta.type === FieldType.Attachment) {
        attachmentFields.push({ id: meta.id, name: meta.name });
      }
      const { normalized, readonly } = mapFeishuFieldType(meta.type);
      const prop = meta.property as { options?: Array<{ id: string; name: string }> } | undefined;
      return {
        id: meta.id,
        name: meta.name,
        type: normalized,
        rawType: meta.type,
        readonly,
        options: prop?.options?.map((o) => ({ id: o.id, name: o.name })),
      };
    });

    // Read up to 3 sample rows for context formatting
    const sampleRows: Array<Record<string, unknown>> = [];
    try {
      const recordIds = (await table.getRecordIdList()).slice(0, 3);
      for (const rid of recordIds) {
        const rowObj: Record<string, unknown> = {};
        for (const f of fields.filter((x) => !x.readonly)) {
          try {
            const val = await table.getCellString(f.id, rid);
            if (val) rowObj[f.name] = val;
          } catch {
            // Skip unreadable field cell
          }
        }
        if (Object.keys(rowObj).length > 0) {
          sampleRows.push(rowObj);
        }
      }
    } catch {
      // Ignore sample read failures on empty tables
    }

    return {
      tableId: table.id,
      tableName,
      fields,
      attachmentFields,
      sampleRows,
    };
  }

  /**
   * Scans up to 50 records in the specified Attachment column and collects
   * temporary download URLs using direct table.getCellAttachmentUrls (halves RPC calls).
   */
  async readAttachmentsFromField(fieldId: string): Promise<HostAttachmentItem[]> {
    const table = await bitable.base.getActiveTable();
    const attachmentField = await table.getField<IAttachmentField>(fieldId);
    const recordIds = (await table.getRecordIdList()).slice(0, 50);

    const results: HostAttachmentItem[] = [];

    for (const recordId of recordIds) {
      let cellAttachments: IOpenAttachment[] | null = null;
      try {
        cellAttachments = await attachmentField.getValue(recordId);
      } catch {
        continue;
      }
      if (!cellAttachments || cellAttachments.length === 0) continue;

      let urls: string[] = [];
      try {
        const tokens = cellAttachments.map((a) => a.token);
        urls = await table.getCellAttachmentUrls(tokens, fieldId, recordId);
      } catch {
        try {
          urls = await attachmentField.getAttachmentUrls(recordId);
        } catch {
          continue;
        }
      }

      cellAttachments.forEach((att, idx) => {
        const url = urls[idx];
        if (!url) return;
        results.push({
          id: `${recordId}_${att.token || idx}`,
          recordId,
          fileName: att.name,
          mimeType: att.type || 'application/octet-stream',
          size: att.size || 0,
          url,
        });
      });
    }

    return results;
  }

  async writeValidatedRows(
    schema: TableSchema,
    rows: ValidatedRow[]
  ): Promise<{ writtenCount: number }> {
    // Always target the exact table that was extracted against (even if user switched tabs)
    const table = schema.tableId
      ? await bitable.base.getTableById(schema.tableId).catch(() => bitable.base.getActiveTable())
      : await bitable.base.getActiveTable();

    const fieldMap = new Map(schema.fields.map((f) => [f.id, f]));
    const latestOptionsMap = new Map<string, SelectOption[]>();

    // Ensure any newly extracted SingleSelect / MultiSelect option names exist before writing
    for (const field of schema.fields) {
      if (field.readonly || (field.type !== 'singleSelect' && field.type !== 'multiSelect')) {
        continue;
      }
      const existingOpts = field.options ? [...field.options] : [];
      const missingNames = new Set<string>();

      for (const row of rows) {
        const cell = row.cells[field.id];
        if (!cell || cell.value === null || cell.value === undefined || cell.value === '') continue;
        const candidates =
          field.type === 'multiSelect'
            ? splitMultiSelectValues(cell.value)
            : [String(cell.value).trim()].filter(Boolean);
        for (const name of candidates) {
          if (!findOption(existingOpts, name)) {
            missingNames.add(name);
          }
        }
      }

      if (missingNames.size > 0) {
        try {
          const selectField = await table.getField<ISingleSelectField | IMultiSelectField>(field.id);
          await selectField.addOptions(Array.from(missingNames).map((name) => ({ name })));
          const refreshed = await selectField.getOptions();
          latestOptionsMap.set(
            field.id,
            refreshed.map((o) => ({ id: o.id, name: o.name }))
          );
        } catch {
          // User may lack schema-edit permission; gracefully keep existing options
          latestOptionsMap.set(field.id, existingOpts);
        }
      } else {
        latestOptionsMap.set(field.id, existingOpts);
      }
    }

    const records: IRecordValue[] = rows.map((row) => {
      const fieldsPayload: Record<string, IOpenCellValue> = {};
      for (const [fieldId, cell] of Object.entries(row.cells)) {
        const field = fieldMap.get(fieldId);
        if (!field || field.readonly) continue;
        const formatted = toFeishuCellValue(field, cell.value, latestOptionsMap.get(fieldId));
        if (formatted !== undefined) {
          fieldsPayload[fieldId] = formatted;
        }
      }
      return { fields: fieldsPayload };
    });

    // Chunk into 200-record batches per Feishu SDK addRecords limit
    const BATCH_SIZE = 200;
    let writtenCount = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const ids = await table.addRecords(batch);
      writtenCount += ids.length;
    }

    return { writtenCount };
  }
}

export async function isInsideFeishuBitable(timeoutMs = 2500): Promise<boolean> {
  if (typeof window === 'undefined' || window.parent === window) {
    return false;
  }
  try {
    const res = await Promise.race([
      bitable.base.getActiveTable().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return res;
  } catch {
    return false;
  }
}

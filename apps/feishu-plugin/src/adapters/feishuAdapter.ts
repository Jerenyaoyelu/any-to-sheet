import {
  bitable,
  FieldType,
  type IAttachmentField,
  type IOpenAttachment,
  type IOpenCellValue,
  type IRecordValue,
} from '@lark-base-open/js-sdk';
import type {
  AttachmentFieldInfo,
  FieldSchema,
  HostAdapter,
  HostAttachmentItem,
  NormalizedFieldType,
  SelectOption,
  TableSchema,
  ValidatedRow,
} from '@table-ai/core';

function mapFeishuFieldType(type: FieldType): { normalized: NormalizedFieldType; readonly: boolean } {
  switch (type) {
    case FieldType.Text:
      return { normalized: 'text', readonly: false };
    case FieldType.Number:
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

function toFeishuCellValue(field: FieldSchema, value: unknown): IOpenCellValue | undefined {
  if (value === null || value === undefined || value === '') return undefined;

  switch (field.type) {
    case 'text':
    case 'email':
      return [{ type: 'text', text: String(value) }] as unknown as IOpenCellValue;
    case 'phone':
      return String(value) as unknown as IOpenCellValue;
    case 'url': {
      const link = String(value);
      return [{ type: 'url', text: link, link }] as unknown as IOpenCellValue;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? (n as unknown as IOpenCellValue) : undefined;
    }
    case 'date': {
      const ts = Date.parse(String(value));
      return Number.isNaN(ts) ? undefined : (ts as unknown as IOpenCellValue);
    }
    case 'checkbox':
      return Boolean(value) as unknown as IOpenCellValue;
    case 'singleSelect': {
      const text = String(value);
      const matched = field.options?.find((o) => o.name === text);
      if (matched) {
        return { id: matched.id, text: matched.name } as unknown as IOpenCellValue;
      }
      return undefined;
    }
    case 'multiSelect': {
      const items = Array.isArray(value) ? value.map(String) : [String(value)];
      const matched = items
        .map((name) => field.options?.find((o) => o.name === name))
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

  async getActiveTableSchema(): Promise<TableSchema> {
    const table = await bitable.base.getActiveTable();
    const tableName = await table.getName();
    const selection = await bitable.base.getSelection();

    const fieldMetaList = selection.viewId
      ? await (await table.getViewById(selection.viewId)).getFieldMetaList()
      : await table.getFieldMetaList();

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
   * temporary download URLs for all image/PDF/text attachments.
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
        urls = await attachmentField.getAttachmentUrls(recordId);
      } catch {
        continue;
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
    const table = await bitable.base.getActiveTable();
    const fieldMap = new Map(schema.fields.map((f) => [f.id, f]));

    const records: IRecordValue[] = rows.map((row) => {
      const fieldsPayload: Record<string, IOpenCellValue> = {};
      for (const [fieldId, cell] of Object.entries(row.cells)) {
        const field = fieldMap.get(fieldId);
        if (!field || field.readonly) continue;
        const formatted = toFeishuCellValue(field, cell.value);
        if (formatted !== undefined) {
          fieldsPayload[fieldId] = formatted;
        }
      }
      return { fields: fieldsPayload };
    });

    const recordIds = await table.addRecords(records);
    return { writtenCount: recordIds.length };
  }
}

export async function isInsideFeishuBitable(timeoutMs = 800): Promise<boolean> {
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

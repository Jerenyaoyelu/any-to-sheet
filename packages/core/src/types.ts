export type NormalizedFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'singleSelect'
  | 'multiSelect'
  | 'checkbox'
  | 'url'
  | 'phone'
  | 'email'
  | 'unknown';

export interface SelectOption {
  id: string;
  name: string;
}

export interface FieldSchema {
  id: string;
  name: string;
  type: NormalizedFieldType;
  /** Original host-specific field type (e.g. Feishu FieldType number) */
  rawType?: string | number;
  options?: SelectOption[];
  readonly?: boolean;
}

export interface AttachmentFieldInfo {
  id: string;
  name: string;
}

export interface HostAttachmentItem {
  id: string;
  recordId: string;
  fileName: string;
  mimeType: string;
  size: number;
  url?: string;
  /** Optional direct File object (used in local mock mode or direct browser blobs) */
  file?: File;
}

export interface TableSchema {
  tableId: string;
  tableName: string;
  fields: FieldSchema[];
  /** Attachment columns detected on the table (used for one-click extraction from existing attachments) */
  attachmentFields?: AttachmentFieldInfo[];
  /** First 2-3 sample rows to help the model understand formatting conventions */
  sampleRows: Array<Record<string, unknown>>;
}

export type CellStatus = 'ok' | 'warning' | 'error';

export interface ValidatedCell {
  fieldId: string;
  fieldName: string;
  value: unknown;
  rawValue: unknown;
  confidence: number;
  status: CellStatus;
  reason?: string;
}

export interface ValidatedRow {
  rowId: string;
  sourceFileName: string;
  cells: Record<string, ValidatedCell>;
  /** Arithmetic or other row-level checks. Informational model notes live in `notes`. */
  rowWarnings: string[];
  /** Facts from the source that did not fit any column. Empty when every fact mapped. */
  notes?: string;
}

export interface ExtractionRawItem {
  sourceFileName: string;
  values: Record<string, unknown>;
  confidence?: Record<string, number>;
  notes?: string;
}

export interface QuotaSnapshot {
  userId: string;
  tier: 'free' | 'pro';
  dailyRemaining: number;
  dailyLimit: number;
  welcomeRemaining: number;
  paidRemaining: number;
  totalAvailable: number;
  maxFilesPerRequest: number;
  maxPdfPages: number;
  globalFreeRemainingToday: number;
}

export interface UserIdentity {
  userId: string;
  tenantKey?: string;
}

export interface ExtractResponse {
  mode: 'llm' | 'mock';
  model: string;
  rows: ValidatedRow[];
  estimatedCostCny: number;
  consumedPages: number;
  quota: QuotaSnapshot;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface TableSummary {
  tableId: string;
  tableName: string;
}

export interface TableRecordRow {
  recordId: string;
  /** Raw/stringified values keyed by fieldId */
  values: Record<string, unknown>;
}

export interface TableRecordUpdate {
  recordId: string;
  /** Updated values keyed by fieldId */
  values: Record<string, unknown>;
}

/**
 * HostAdapter decouples business logic from specific spreadsheet hosts.
 * Phase 1: FeishuHostAdapter (and MockHostAdapter for standalone browser dev)
 * Phase 2: WpsHostAdapter / ExcelHostAdapter
 */
export interface HostAdapter {
  readonly hostName: string;
  getUserIdentity?(): Promise<UserIdentity>;
  getActiveTableSchema(preferredTableId?: string): Promise<TableSchema>;
  listTables?(): Promise<TableSummary[]>;
  readTableRecords?(
    tableId?: string,
    limit?: number
  ): Promise<{ schema: TableSchema; records: TableRecordRow[] }>;
  updateTableRecords?(
    schema: TableSchema,
    updates: TableRecordUpdate[]
  ): Promise<{ updatedCount: number }>;
  readAttachmentsFromField?(fieldId: string): Promise<HostAttachmentItem[]>;
  writeValidatedRows(schema: TableSchema, rows: ValidatedRow[]): Promise<{ writtenCount: number }>;
}

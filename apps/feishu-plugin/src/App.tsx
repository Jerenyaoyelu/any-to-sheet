import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  revalidateEditedRow,
  type ExtractResponse,
  type HostAdapter,
  type HostAttachmentItem,
  type QuotaSnapshot,
  type TableSchema,
  type UserIdentity,
  type ValidatedRow,
} from '@table-ai/core';
import { FeishuHostAdapter, isInsideFeishuBitable } from './adapters/feishuAdapter';
import { DEMO_SCHEMAS, MockHostAdapter } from './adapters/mockAdapter';
import {
  isPdfFile,
  prepareFilesForExtraction,
  resolveAttachmentToFile,
} from './utils/pdfToImages';

const FIELD_TYPE_LABEL: Record<string, string> = {
  text: '文本',
  number: '数字',
  date: '日期',
  singleSelect: '单选',
  multiSelect: '多选',
  checkbox: '复选',
  phone: '电话',
  url: '链接',
  email: '邮箱',
};

type InputSourceTab = 'upload' | 'attachment';
type AlertMessage = { type: 'info' | 'success' | 'error'; text: string };

/** In-memory workspace for one table. Gone when the plugin panel is closed. */
type TableSession = {
  rows: ValidatedRow[];
  extractResult: ExtractResponse | null;
  writtenDone: boolean;
  message: AlertMessage | null;
  files: File[];
  userHint: string;
  sourceTab: InputSourceTab;
};

function emptySession(): TableSession {
  return {
    rows: [],
    extractResult: null,
    writtenDone: false,
    message: null,
    files: [],
    userHint: '',
    sourceTab: 'upload',
  };
}

function quotaHint(quota: QuotaSnapshot): string {
  const parts: string[] = [];
  if (quota.dailyRemaining <= 0 && quota.totalAvailable > 0) {
    parts.push('今日免费已用完');
  } else {
    parts.push(`今日免费 ${quota.dailyRemaining}/${quota.dailyLimit}`);
  }
  if (quota.welcomeRemaining > 0) parts.push(`新人 ${quota.welcomeRemaining}`);
  if (quota.paidRemaining > 0) parts.push(`永久 ${quota.paidRemaining}`);
  return parts.join(' · ');
}

function isMoneyField(name: string): boolean {
  return /金额|单价|总价|合计|小计|价格|费用|实付|售价/.test(name);
}

function formatMoney(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (value === null || value === undefined) return '';
  return String(value);
}

function selectedNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，、;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function reviewTitle(rowCount: number, issueCount: number, noteCount: number): string {
  const base = `3. 提取预览与复核（${rowCount} 条`;
  if (issueCount > 0 && noteCount > 0) return `${base}，${issueCount} 处标黄，另有未入表信息）`;
  if (issueCount > 0) return `${base}，${issueCount} 处标黄待复核）`;
  if (noteCount > 0) return `${base}，有未入表信息）`;
  return `${base}，全部校验通过）`;
}

function MoneyInput({
  value,
  title,
  onCommit,
}: {
  value: unknown;
  title?: string;
  onCommit: (raw: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const shown = formatMoney(value);
  return (
    <input
      className="cell-input"
      title={title}
      inputMode="decimal"
      value={focused ? draft : shown}
      onFocus={() => {
        setFocused(true);
        setDraft(shown);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft !== shown) onCommit(draft);
      }}
    />
  );
}

async function safeParseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `服务端返回异常 (${res.status})：${text.slice(0, 120)}` };
  }
}

export default function App() {
  const [adapter, setAdapter] = useState<HostAdapter | null>(null);
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [serverMode, setServerMode] = useState<'llm' | 'mock'>('mock');
  const [demoKey, setDemoKey] = useState<keyof typeof DEMO_SCHEMAS>('quote');

  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [showRedeem, setShowRedeem] = useState(false);
  const [redeemInput, setRedeemInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemFeedback, setRedeemFeedback] = useState<AlertMessage | null>(null);

  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<InputSourceTab>('upload');

  // Local upload state
  const [files, setFiles] = useState<File[]>([]);

  // Feishu attachment column state
  const [selectedAttFieldId, setSelectedAttFieldId] = useState('');
  const [attachments, setAttachments] = useState<HostAttachmentItem[]>([]);
  const [selectedAttIds, setSelectedAttIds] = useState<string[]>([]);
  const [scanningAtt, setScanningAtt] = useState(false);

  const [maxPdfPages, setMaxPdfPages] = useState(3);
  const [userHint, setUserHint] = useState('');

  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [writing, setWriting] = useState(false);
  const [writtenDone, setWrittenDone] = useState(false);
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);
  const [rows, setRows] = useState<ValidatedRow[]>([]);
  const [message, setMessage] = useState<AlertMessage | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const schemaRef = useRef<TableSchema | null>(null);
  const rowsRef = useRef<ValidatedRow[]>([]);
  const extractResultRef = useRef<ExtractResponse | null>(null);
  const writtenDoneRef = useRef(false);
  const messageRef = useRef<AlertMessage | null>(null);
  const filesRef = useRef<File[]>([]);
  const userHintRef = useRef('');
  const sourceTabRef = useRef<InputSourceTab>('upload');
  const loadingRef = useRef(false);
  const pendingTableId = useRef<string | null>(null);
  const switchToken = useRef(0);
  const applyTableRef = useRef<(tableId: string) => void>(() => {});
  const sessionsRef = useRef(new Map<string, TableSession>());
  schemaRef.current = schema;
  rowsRef.current = rows;
  extractResultRef.current = extractResult;
  writtenDoneRef.current = writtenDone;
  messageRef.current = message;
  filesRef.current = files;
  userHintRef.current = userHint;
  sourceTabRef.current = sourceTab;
  loadingRef.current = loading;

  function snapshotSession(): TableSession {
    return {
      rows: rowsRef.current,
      extractResult: extractResultRef.current,
      writtenDone: writtenDoneRef.current,
      message: messageRef.current,
      files: filesRef.current,
      userHint: userHintRef.current,
      sourceTab: sourceTabRef.current,
    };
  }

  function rememberCurrentTable() {
    const tableId = schemaRef.current?.tableId;
    if (!tableId) return;
    sessionsRef.current.set(tableId, snapshotSession());
  }

  function applySession(session: TableSession) {
    rowsRef.current = session.rows;
    extractResultRef.current = session.extractResult;
    writtenDoneRef.current = session.writtenDone;
    messageRef.current = session.message;
    filesRef.current = session.files;
    userHintRef.current = session.userHint;
    sourceTabRef.current = session.sourceTab;
    setRows(session.rows);
    setExtractResult(session.extractResult);
    setWrittenDone(session.writtenDone);
    setMessage(session.message);
    setFiles(session.files);
    setUserHint(session.userHint);
    setSourceTab(session.sourceTab);
  }

  function buildIdentityHeaders(idObj: UserIdentity | null): Record<string, string> {
    const headers: Record<string, string> = {};
    if (idObj?.userId) headers['x-user-id'] = idObj.userId;
    if (idObj?.tenantKey) headers['x-tenant-key'] = idObj.tenantKey;
    return headers;
  }

  async function fetchQuota(idObj: UserIdentity) {
    try {
      const res = await fetch('/api/quota', {
        headers: buildIdentityHeaders(idObj),
      });
      if (!res.ok) return;
      const data = (await safeParseJson(res)) as { mode?: 'llm' | 'mock'; quota?: QuotaSnapshot };
      if (data.mode) setServerMode(data.mode);
      if (data.quota) {
        setQuota(data.quota);
        setMaxPdfPages((prev) => Math.min(prev, data.quota!.maxPdfPages));
      }
    } catch {
      // Backend might be offline; handled on extract
    }
  }

  function syncDefaultAttachmentField(nextSchema: TableSchema) {
    const firstAtt = nextSchema.attachmentFields?.[0]?.id || '';
    setSelectedAttFieldId(firstAtt);
    setAttachments([]);
    setSelectedAttIds([]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inFeishu = await isInsideFeishuBitable();
        const activeAdapter: HostAdapter = inFeishu ? new FeishuHostAdapter() : new MockHostAdapter();
        if (cancelled) return;
        setAdapter(activeAdapter);
        setIsMock(!inFeishu);

        const [nextSchema, nextId] = await Promise.all([
          activeAdapter.getActiveTableSchema(),
          activeAdapter.getUserIdentity
            ? activeAdapter.getUserIdentity()
            : Promise.resolve({ userId: 'anonymous' }),
        ]);

        if (cancelled) return;
        setSchema(nextSchema);
        setIdentity(nextId);
        setInitError(null);
        syncDefaultAttachmentField(nextSchema);
        await fetchQuota(nextId);
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : '初始化读取表格结构失败，请点击重试');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!adapter || isMock || !(adapter instanceof FeishuHostAdapter)) return;
    const feishu = adapter;

    async function applyActiveTable(tableId: string) {
      if (schemaRef.current?.tableId === tableId) return;
      const token = ++switchToken.current;
      try {
        const next = await feishu.getActiveTableSchema(tableId);
        if (token !== switchToken.current) return;
        if (schemaRef.current?.tableId === next.tableId) return;
        rememberCurrentTable();
        schemaRef.current = next;
        setSchema(next);
        setInitError(null);
        syncDefaultAttachmentField(next);
        applySession(sessionsRef.current.get(next.tableId) ?? emptySession());
      } catch (err) {
        if (token !== switchToken.current) return;
        setMessage({
          type: 'error',
          text: err instanceof Error ? err.message : '切换数据表后读取表头失败',
        });
      }
    }

    applyTableRef.current = (tableId: string) => {
      void applyActiveTable(tableId);
    };

    const unsubscribe = feishu.onActiveTableChange((tableId) => {
      if (!tableId || tableId === schemaRef.current?.tableId) {
        if (tableId && tableId === schemaRef.current?.tableId) pendingTableId.current = null;
        return;
      }
      if (loadingRef.current) {
        pendingTableId.current = tableId;
        return;
      }
      void applyActiveTable(tableId);
    });

    return () => {
      switchToken.current += 1;
      applyTableRef.current = () => {};
      unsubscribe();
    };
  }, [adapter, isMock]);

  const writableFields = useMemo(
    () => schema?.fields.filter((f) => !f.readonly && f.type !== 'unknown') ?? [],
    [schema]
  );

  const warningCount = useMemo(() => {
    let count = 0;
    for (const r of rows) {
      for (const c of Object.values(r.cells)) {
        if (c.status !== 'ok') count++;
      }
    }
    return count;
  }, [rows]);

  const allRowWarnings = useMemo(() => {
    const list: Array<{ rowNum: number; text: string }> = [];
    rows.forEach((r, idx) => {
      r.rowWarnings.forEach((w) => {
        list.push({ rowNum: idx + 1, text: w });
      });
    });
    return list;
  }, [rows]);

  const noteCount = useMemo(() => rows.filter((r) => r.notes?.trim()).length, [rows]);
  const issueCount = warningCount + allRowWarnings.length;

  const maxFilesAllowed = quota?.maxFilesPerRequest ?? 3;
  const maxPdfAllowed = quota?.maxPdfPages ?? 3;
  const activeCount = sourceTab === 'upload' ? files.length : selectedAttIds.length;

  async function handleRefreshSchema(nextDemoKey?: keyof typeof DEMO_SCHEMAS) {
    if (!adapter) return;
    try {
      if (isMock && nextDemoKey && adapter instanceof MockHostAdapter) {
        adapter.setDemoSchema(nextDemoKey);
        setDemoKey(nextDemoKey);
      }
      const nextSchema = await adapter.getActiveTableSchema();
      if (schemaRef.current?.tableId && schemaRef.current.tableId !== nextSchema.tableId) {
        rememberCurrentTable();
        schemaRef.current = nextSchema;
        setSchema(nextSchema);
        setInitError(null);
        syncDefaultAttachmentField(nextSchema);
        applySession(sessionsRef.current.get(nextSchema.tableId) ?? emptySession());
        return;
      }
      schemaRef.current = nextSchema;
      setSchema(nextSchema);
      setInitError(null);
      setSelectedAttFieldId((prev) =>
        nextSchema.attachmentFields?.some((field) => field.id === prev)
          ? prev
          : nextSchema.attachmentFields?.[0]?.id || ''
      );
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '重新读取表头失败',
      });
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList) return;
    const incoming = Array.from(fileList);
    setFiles((prev) => [...prev, ...incoming].slice(0, maxFilesAllowed));
    setMessage(null);
    // Reset input so removing and re-selecting the same file works cleanly
    e.target.value = '';
  }

  function handleDropFiles(fileList: FileList | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    setFiles((prev) => [...prev, ...incoming].slice(0, maxFilesAllowed));
    setMessage(null);
  }

  function handleRemoveFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleAttachmentFieldChange(nextFieldId: string) {
    setSelectedAttFieldId(nextFieldId);
    setAttachments([]);
    setSelectedAttIds([]);
    setMessage(null);
  }

  async function handleScanAttachmentColumn() {
    if (!adapter?.readAttachmentsFromField || !selectedAttFieldId) return;
    setScanningAtt(true);
    setMessage(null);
    try {
      const list = await adapter.readAttachmentsFromField(selectedAttFieldId);
      setAttachments(list);
      setSelectedAttIds(list.slice(0, maxFilesAllowed).map((a) => a.id));
      if (list.length === 0) {
        setMessage({
          type: 'info',
          text: '该附件列前 50 行中暂未发现附件文件。',
        });
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '读取附件列失败',
      });
    } finally {
      setScanningAtt(false);
    }
  }

  function toggleAttachment(id: string) {
    setSelectedAttIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= maxFilesAllowed) {
        setMessage({
          type: 'info',
          text: `当前套餐单次最多选择 ${maxFilesAllowed} 份文件，请先取消其他勾选或升级 Pro。`,
        });
        return prev;
      }
      return [...prev, id];
    });
  }

  async function handleRedeemCode() {
    if (!identity || !redeemInput.trim()) return;
    setRedeeming(true);
    setRedeemFeedback(null);
    try {
      const res = await fetch('/api/quota/redeem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildIdentityHeaders(identity),
        },
        body: JSON.stringify({ code: redeemInput.trim() }),
      });
      const data = await safeParseJson(res);
      if (!res.ok) {
        throw new Error(String(data.error || '兑换失败'));
      }
      if (data.quota) {
        setQuota(data.quota as QuotaSnapshot);
      }
      setRedeemInput('');
      setRedeemFeedback({
        type: 'success',
        text: `兑换成功！已到账 ${String(data.addedPages)} 页永久付费额度，已自动解锁 Pro 批量与高精模式。`,
      });
    } catch (err) {
      setRedeemFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : '激活码兑换失败',
      });
    } finally {
      setRedeeming(false);
    }
  }

  async function handleExtract() {
    if (!schema || activeCount === 0) return;
    const startedTableId = schema.tableId;
    setLoading(true);
    loadingRef.current = true;
    messageRef.current = null;
    writtenDoneRef.current = false;
    setMessage(null);
    setWrittenDone(false);
    setProgressText('');
    try {
      let rawFiles: File[] = [];

      if (sourceTab === 'upload') {
        rawFiles = files;
      } else {
        const chosen = attachments.filter((a) => selectedAttIds.includes(a.id));
        for (let i = 0; i < chosen.length; i++) {
          setProgressText(`正在拉取附件 (${i + 1}/${chosen.length})：${chosen[i].fileName}`);
          const f = await resolveAttachmentToFile(chosen[i]);
          rawFiles.push(f);
        }
      }

      const effectivePdfPages = Math.min(maxPdfPages, maxPdfAllowed);
      const { files: preparedFiles, skippedPdfPages } = await prepareFilesForExtraction(rawFiles, {
        maxPages: effectivePdfPages,
        scale: 2.0,
        onProgress: (txt) => setProgressText(txt),
      });

      // Pre-check total expanded PDF page count BEFORE uploading so user gets a clear message
      if (preparedFiles.length > maxFilesAllowed) {
        setShowRedeem(true);
        throw new Error(
          `展开 PDF 后共 ${preparedFiles.length} 页，超过当前套餐单次上限（${maxFilesAllowed} 页/图）。请调小「PDF 上限」或分批上传，或兑换激活码升级 Pro（单次 20 页）。`
        );
      }
      if (quota && preparedFiles.length > quota.totalAvailable) {
        setShowRedeem(true);
        throw new Error(
          `展开后共需 ${preparedFiles.length} 页额度，当前剩余 ${quota.totalAvailable} 页。请减少上传页数或兑换激活码充值。`
        );
      }

      setProgressText(`正在调用 AI 提取 ${preparedFiles.length} 页/份文件并执行校验...`);

      const formData = new FormData();
      preparedFiles.forEach((f) => formData.append('files', f));
      formData.append('schema', JSON.stringify(schema));
      if (userHint.trim()) {
        formData.append('userHint', userHint.trim());
      }

      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: buildIdentityHeaders(identity),
        body: formData,
      });

      const data = await safeParseJson(res);
      if (data.quota) {
        setQuota(data.quota as QuotaSnapshot);
      }
      if (!res.ok) {
        if (res.status === 402 || res.status === 403 || res.status === 429) {
          setShowRedeem(true);
        }
        throw new Error(String(data.error || '提取失败'));
      }

      const typed = data as unknown as ExtractResponse;
      const skipNote =
        skippedPdfPages > 0 ? `（有 ${skippedPdfPages} 页超出单份 PDF 上限已跳过）` : '';
      const unmapped = typed.rows.some((row) => row.notes?.trim()) ? '有未入表信息，' : '';
      const info: AlertMessage = {
        type: 'info',
        text: `已提取 ${typed.rows.length} 条记录${skipNote}（消耗 ${typed.consumedPages} 页，剩余 ${typed.quota.totalAvailable} 页），${unmapped}请核对后再写入表格。`,
      };
      rowsRef.current = typed.rows;
      extractResultRef.current = typed;
      writtenDoneRef.current = false;
      messageRef.current = info;
      const switchedAway =
        (pendingTableId.current && pendingTableId.current !== startedTableId) ||
        schemaRef.current?.tableId !== startedTableId;
      if (switchedAway) {
        sessionsRef.current.set(startedTableId, snapshotSession());
        return;
      }
      setExtractResult(typed);
      setRows(typed.rows);
      setMessage(info);
    } catch (err) {
      const alert: AlertMessage = {
        type: 'error',
        text: err instanceof Error ? err.message : '请求失败，请确认后端服务已启动（pnpm dev:server）',
      };
      messageRef.current = alert;
      setMessage(alert);
    } finally {
      setLoading(false);
      loadingRef.current = false;
      setProgressText('');
      const nextId = pendingTableId.current;
      if (nextId && nextId !== schemaRef.current?.tableId) {
        pendingTableId.current = null;
        applyTableRef.current(nextId);
      }
    }
  }

  function handleCellEdit(rowId: string, fieldId: string, newValue: unknown) {
    if (!schema) return;
    writtenDoneRef.current = false;
    setWrittenDone(false);
    setRows((prev) => {
      const next = prev.map((row) =>
        row.rowId === rowId ? revalidateEditedRow(schema, row, fieldId, newValue) : row
      );
      rowsRef.current = next;
      return next;
    });
  }

  function handleDeleteRow(rowId: string) {
    writtenDoneRef.current = false;
    setWrittenDone(false);
    setRows((prev) => {
      const next = prev.filter((r) => r.rowId !== rowId);
      rowsRef.current = next;
      return next;
    });
  }

  async function handleWriteToTable() {
    if (!adapter || !schema || rows.length === 0 || writtenDone) return;
    setWriting(true);
    setMessage(null);
    try {
      const { writtenCount } = await adapter.writeValidatedRows(schema, rows);
      setWrittenDone(true);
      setMessage({
        type: 'success',
        text: isMock
          ? `试写成功。${writtenCount} 条已记在本地「${schema.tableName}」，接入飞书侧边栏后才会写入真实多维表格。`
          : `成功写入 ${writtenCount} 条记录到飞书多维表格「${schema.tableName}」！`,
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '写入表格失败',
      });
    } finally {
      setWriting(false);
    }
  }

  return (
    <div className="container">
      <header className="header">
        <div className="header-text">
          <h1>AnyToSheet 万物入表</h1>
          <p className="subtitle">自动读取表头 · 扫描版 PDF 转高清图 · 附件列批量提取 · 标黄校验复核</p>
        </div>
        <span className={`badge ${!isMock || serverMode === 'llm' ? 'badge-live' : 'badge-mock'}`}>
          {!isMock ? '飞书已连接' : serverMode === 'llm' ? '本地联调 · 真实模型' : '本地演示 · Mock'}
        </span>
      </header>

      {/* Quota Status Bar */}
      {quota && (
        <section className="quota-bar">
          <div className="quota-info">
            <span className={`tier-pill ${quota.tier === 'pro' ? 'tier-pro' : 'tier-free'}`}>
              {quota.tier === 'pro' ? 'Pro 会员' : '免费版'}
            </span>
            <span>
              可用 <strong>{quota.totalAvailable}</strong> 页
            </span>
            <small className="muted">（{quotaHint(quota)}）</small>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setShowRedeem((prev) => !prev);
              setRedeemFeedback(null);
            }}
          >
            {showRedeem ? '收起兑换' : '兑换激活码'}
          </button>
        </section>
      )}

      {showRedeem && (
        <section className="card redeem-card">
          <div className="card-header">
            <strong>兑换 Pro 激活码</strong>
            <small className="muted">解锁单次 20 页 + PDF 10 页/份 + 高精模型</small>
          </div>
          <div className="att-toolbar">
            <input
              className="hint-input"
              style={{ flex: 1, minWidth: 0 }}
              type="text"
              placeholder={serverMode === 'mock' ? '测试码：ATS-DEMO-100' : '输入激活码 ATS-XXXX-XXXX'}
              value={redeemInput}
              onChange={(e) => setRedeemInput(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={redeeming || !redeemInput.trim()}
              onClick={handleRedeemCode}
            >
              {redeeming ? '兑换中...' : '立即兑换'}
            </button>
          </div>
          {redeemFeedback && (
            <div className={`alert alert-${redeemFeedback.type}`}>{redeemFeedback.text}</div>
          )}
        </section>
      )}

      {/* Step 1: Target Table Schema */}
      <section className="card">
        <div className="card-header">
          <strong>1. 当前表头</strong>
          <div className="row-actions">
            {isMock && (
              <select
                className="select"
                value={demoKey}
                onChange={(e) => handleRefreshSchema(e.target.value as keyof typeof DEMO_SCHEMAS)}
              >
                <option value="quote">示例：供应商报价单</option>
                <option value="resume">示例：HR 简历初筛</option>
                <option value="expense">示例：票据/转账台账</option>
              </select>
            )}
            <button
              className="btn btn-ghost"
              title="列有改动时重新读取。换一张表会自动更新。"
              onClick={() => handleRefreshSchema()}
            >
              重新读取
            </button>
          </div>
        </div>
        {initError ? (
          <div className="alert alert-error">{initError}</div>
        ) : schema ? (
          <>
            <div className="table-title">当前数据表：{schema.tableName}</div>
            <div className="table-hint">
              从当前数据表自动读取。换一张表，下面的文件和提取结果会换成那张表上一次的；关掉插件再打开会清空。
            </div>
            <div className="field-tags">
              {writableFields.map((f) => (
                <span
                  key={f.id}
                  className="field-tag"
                  title={f.options ? `选项: ${f.options.map((o) => o.name).join(' / ')}` : ''}
                >
                  {f.name}
                  <em>{FIELD_TYPE_LABEL[f.type] || f.type}</em>
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="muted">正在读取表格结构...</div>
        )}
      </section>

      {/* Step 2: Input Source */}
      <section className="card">
        <div className="card-header">
          <strong>
            2. 选择待识别文件 <small className="muted">（单次上限 {maxFilesAllowed} 页/图）</small>
          </strong>
          <div className="tabs">
            <button
              className={`tab ${sourceTab === 'upload' ? 'tab-active' : ''}`}
              onClick={() => setSourceTab('upload')}
            >
              本地上传 / PDF
            </button>
            <button
              className={`tab ${sourceTab === 'attachment' ? 'tab-active' : ''}`}
              onClick={() => setSourceTab('attachment')}
            >
              读取附件列
            </button>
          </div>
        </div>

        {sourceTab === 'upload' ? (
          <>
            <div
              className="dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleDropFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.csv,.json"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <div>点击选择或拖入 图片 / 微信截图 / PDF / 文本</div>
              <small>按实际提取页数计费（1 张图或 1 页 PDF = 1 页额度），失败不扣费</small>
            </div>

            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, idx) => (
                  <li key={`${f.name}-${idx}`}>
                    <span className="file-name">
                      {isPdfFile(f) && <span className="pill-pdf">PDF 转高清图</span>}
                      {f.name} <small>({(f.size / 1024).toFixed(1)} KB)</small>
                    </span>
                    <button className="link-danger" onClick={() => handleRemoveFile(idx)}>
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="att-panel">
            {schema?.attachmentFields && schema.attachmentFields.length > 0 ? (
              <>
                <div className="att-toolbar">
                  <select
                    className="select"
                    style={{ flex: 1, minWidth: 0 }}
                    value={selectedAttFieldId}
                    onChange={(e) => handleAttachmentFieldChange(e.target.value)}
                  >
                    {schema.attachmentFields.map((af) => (
                      <option key={af.id} value={af.id}>
                        附件列：{af.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost"
                    disabled={scanningAtt || !selectedAttFieldId}
                    onClick={handleScanAttachmentColumn}
                  >
                    {scanningAtt ? '扫描中...' : '一键扫描附件列'}
                  </button>
                </div>

                {attachments.length > 0 ? (
                  <ul className="file-list">
                    {attachments.map((att) => {
                      const checked = selectedAttIds.includes(att.id);
                      return (
                        <li key={att.id}>
                          <label className="att-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAttachment(att.id)}
                            />
                            <span className="file-name">
                              {isPdfFile({ name: att.fileName, type: att.mimeType }) && (
                                <span className="pill-pdf">PDF</span>
                              )}
                              {att.fileName}{' '}
                              <small>({(att.size / 1024).toFixed(1)} KB)</small>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="muted">
                    点击「一键扫描附件列」，批量读取表格附件列里的 PDF / 图片直接提取。
                  </div>
                )}
              </>
            ) : (
              <div className="muted">
                当前表格暂未检测到「附件」列，添加附件列后点「重新读取」，或切回「本地上传 / PDF」。
              </div>
            )}
          </div>
        )}

        <div className="options-row">
          <input
            className="hint-input"
            style={{ flex: 1, minWidth: 0 }}
            type="text"
            placeholder="可选说明：如只提含税金额、跳过合计行"
            value={userHint}
            onChange={(e) => setUserHint(e.target.value)}
          />
          <label className="pdf-limit">
            PDF 上限
            <select
              className="select"
              value={Math.min(maxPdfPages, maxPdfAllowed)}
              onChange={(e) => setMaxPdfPages(Number(e.target.value))}
            >
              <option value={3}>3 页/份</option>
              {maxPdfAllowed >= 5 && <option value={5}>5 页/份 (Pro)</option>}
              {maxPdfAllowed >= 10 && <option value={10}>10 页/份 (Pro)</option>}
            </select>
          </label>
        </div>

        <button
          className="btn btn-primary btn-block"
          disabled={loading || activeCount === 0 || !schema}
          onClick={handleExtract}
        >
          {loading
            ? progressText || 'AI 识别与校验中...'
            : `开始智能提取（已选 ${activeCount} 份文件）`}
        </button>
      </section>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      {/* Step 3: Review & Batch Write */}
      {rows.length > 0 && (
        <section className="card">
          <div className="card-header">
            <strong>{reviewTitle(rows.length, issueCount, noteCount)}</strong>
            <div className="row-actions">
              {extractResult && extractResult.mode === 'llm' && (
                <span className="muted">约 ¥{extractResult.estimatedCostCny}</span>
              )}
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setRows([]);
                  setExtractResult(null);
                  setWrittenDone(false);
                }}
              >
                清空
              </button>
            </div>
          </div>

          <div className="review-list">
            {rows.map((row, rowIndex) => (
              <article key={row.rowId} className="review-card">
                <div className="review-card-head">
                  <span className="row-num">第 {rowIndex + 1} 条</span>
                  <span className="source-cell" title={row.sourceFileName}>
                    {row.sourceFileName}
                  </span>
                  <button className="link-danger" onClick={() => handleDeleteRow(row.rowId)}>
                    删行
                  </button>
                </div>

                {row.notes?.trim() && (
                  <div className="notes-summary">未入表：{row.notes}</div>
                )}
                {row.rowWarnings.map((warning, warningIndex) => (
                  <div key={`${row.rowId}-${warningIndex}`} className="warning-item">
                    {warning}
                  </div>
                ))}

                {writableFields.map((f) => {
                  const cell = row.cells[f.id];
                  const isWarn = cell && cell.status !== 'ok';
                  const tooltip =
                    cell?.reason || `置信度 ${Math.round((cell?.confidence ?? 0.9) * 100)}%`;
                  const optionNames = f.options?.map((option) => option.name) ?? [];

                  let control: React.ReactNode;
                  if (f.type === 'checkbox') {
                    control = (
                      <input
                        type="checkbox"
                        checked={Boolean(cell?.value)}
                        onChange={(e) => handleCellEdit(row.rowId, f.id, e.target.checked)}
                      />
                    );
                  } else if (f.type === 'singleSelect' && optionNames.length > 0) {
                    const current = cell?.value == null ? '' : String(cell.value);
                    const known = optionNames.includes(current);
                    control = (
                      <select
                        className="cell-input"
                        title={tooltip}
                        value={current}
                        onChange={(e) => handleCellEdit(row.rowId, f.id, e.target.value)}
                      >
                        <option value="">请选择</option>
                        {f.options!.map((option) => (
                          <option key={option.id} value={option.name}>
                            {option.name}
                          </option>
                        ))}
                        {current && !known && <option value={current}>{current}（不在选项中）</option>}
                      </select>
                    );
                  } else if (f.type === 'multiSelect' && optionNames.length > 0) {
                    const picked = selectedNames(cell?.value);
                    const unknown = picked.filter((name) => !optionNames.includes(name));
                    control = (
                      <div className="multi-options" title={tooltip}>
                        {f.options!.map((option) => (
                          <label key={option.id}>
                            <input
                              type="checkbox"
                              checked={picked.includes(option.name)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...picked, option.name]
                                  : picked.filter((name) => name !== option.name);
                                handleCellEdit(row.rowId, f.id, next);
                              }}
                            />
                            {option.name}
                          </label>
                        ))}
                        {unknown.length > 0 && (
                          <span className="muted">未匹配：{unknown.join('、')}</span>
                        )}
                      </div>
                    );
                  } else if (f.type === 'number' && isMoneyField(f.name)) {
                    control = (
                      <MoneyInput
                        value={cell?.value}
                        title={tooltip}
                        onCommit={(raw) => handleCellEdit(row.rowId, f.id, raw)}
                      />
                    );
                  } else {
                    const displayVal = Array.isArray(cell?.value)
                      ? cell.value.join(', ')
                      : cell?.value ?? '';
                    control = (
                      <input
                        className="cell-input"
                        title={tooltip}
                        value={String(displayVal)}
                        onChange={(e) => handleCellEdit(row.rowId, f.id, e.target.value)}
                      />
                    );
                  }

                  return (
                    <div key={f.id} className={`review-field ${isWarn ? 'review-field-warn' : ''}`}>
                      <span className="review-field-name" title={tooltip}>
                        {f.name}
                      </span>
                      {control}
                    </div>
                  );
                })}
              </article>
            ))}
          </div>

          <button
            className="btn btn-success btn-block btn-wrap"
            disabled={writing || writtenDone || rows.length === 0}
            onClick={handleWriteToTable}
          >
            {writing
              ? '正在写入...'
              : writtenDone
                ? isMock
                  ? `试写成功（${rows.length} 条，未写入飞书）`
                  : `已写入「${schema?.tableName ?? '当前表'}」（${rows.length} 条）`
                : issueCount > 0
                  ? `确认写入「${schema?.tableName ?? '当前表'}」（${rows.length} 条，${issueCount} 处标黄）`
                  : noteCount > 0
                    ? `确认写入「${schema?.tableName ?? '当前表'}」（${rows.length} 条，含未入表信息）`
                    : `写入「${schema?.tableName ?? '当前表'}」（${rows.length} 条）`}
          </button>
        </section>
      )}
    </div>
  );
}

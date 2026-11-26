import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExtractResponse,
  HostAdapter,
  HostAttachmentItem,
  TableSchema,
  ValidatedRow,
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

export default function App() {
  const [adapter, setAdapter] = useState<HostAdapter | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [demoKey, setDemoKey] = useState<keyof typeof DEMO_SCHEMAS>('quote');

  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [sourceTab, setSourceTab] = useState<InputSourceTab>('upload');

  // Local upload state
  const [files, setFiles] = useState<File[]>([]);

  // Feishu attachment column state
  const [selectedAttFieldId, setSelectedAttFieldId] = useState('');
  const [attachments, setAttachments] = useState<HostAttachmentItem[]>([]);
  const [selectedAttIds, setSelectedAttIds] = useState<string[]>([]);
  const [scanningAtt, setScanningAtt] = useState(false);

  const [maxPdfPages, setMaxPdfPages] = useState(5);
  const [userHint, setUserHint] = useState('');

  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [writing, setWriting] = useState(false);
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);
  const [rows, setRows] = useState<ValidatedRow[]>([]);
  const [message, setMessage] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function syncDefaultAttachmentField(nextSchema: TableSchema) {
    const firstAtt = nextSchema.attachmentFields?.[0]?.id || '';
    setSelectedAttFieldId(firstAtt);
    setAttachments([]);
    setSelectedAttIds([]);
  }

  useEffect(() => {
    (async () => {
      const inFeishu = await isInsideFeishuBitable();
      if (inFeishu) {
        const feishu = new FeishuHostAdapter();
        setAdapter(feishu);
        setIsMock(false);
        const s = await feishu.getActiveTableSchema();
        setSchema(s);
        syncDefaultAttachmentField(s);
      } else {
        const mock = new MockHostAdapter();
        setAdapter(mock);
        setIsMock(true);
        const s = await mock.getActiveTableSchema();
        setSchema(s);
        syncDefaultAttachmentField(s);
      }
    })();
  }, []);

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

  const activeCount = sourceTab === 'upload' ? files.length : selectedAttIds.length;

  async function handleRefreshSchema(nextDemoKey?: keyof typeof DEMO_SCHEMAS) {
    if (!adapter) return;
    if (isMock && nextDemoKey && adapter instanceof MockHostAdapter) {
      adapter.setDemoSchema(nextDemoKey);
      setDemoKey(nextDemoKey);
    }
    const nextSchema = await adapter.getActiveTableSchema();
    setSchema(nextSchema);
    syncDefaultAttachmentField(nextSchema);
    setRows([]);
    setExtractResult(null);
    setMessage(null);
  }

  function handleFileChange(fileList: FileList | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    setFiles((prev) => [...prev, ...incoming].slice(0, 10));
    setMessage(null);
  }

  function handleRemoveFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleScanAttachmentColumn() {
    if (!adapter?.readAttachmentsFromField || !selectedAttFieldId) return;
    setScanningAtt(true);
    setMessage(null);
    try {
      const list = await adapter.readAttachmentsFromField(selectedAttFieldId);
      setAttachments(list);
      setSelectedAttIds(list.slice(0, 10).map((a) => a.id));
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
    setSelectedAttIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleExtract() {
    if (!schema || activeCount === 0) return;
    setLoading(true);
    setMessage(null);
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

      const preparedFiles = await prepareFilesForExtraction(rawFiles, {
        maxPages: maxPdfPages,
        scale: 2.0,
        onProgress: (txt) => setProgressText(txt),
      });

      setProgressText(`正在调用 AI 提取 ${preparedFiles.length} 页/份文件并执行校验...`);

      const formData = new FormData();
      preparedFiles.forEach((f) => formData.append('files', f));
      formData.append('schema', JSON.stringify(schema));
      if (userHint.trim()) {
        formData.append('userHint', userHint.trim());
      }

      const res = await fetch('/api/extract', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '提取失败');
      }

      const typed = data as ExtractResponse;
      setExtractResult(typed);
      setRows(typed.rows);
      setMessage({
        type: 'info',
        text: `已提取 ${typed.rows.length} 条记录（共处理 ${preparedFiles.length} 页/图，模式：${typed.mode === 'llm' ? typed.model : 'Mock 演示'}），请核对标黄单元格后写入表格。`,
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '请求失败，请确认后端服务已启动（pnpm dev:server）',
      });
    } finally {
      setLoading(false);
      setProgressText('');
    }
  }

  function handleCellEdit(rowId: string, fieldId: string, newValue: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.rowId !== rowId) return row;
        const target = row.cells[fieldId];
        if (!target) return row;
        return {
          ...row,
          cells: {
            ...row.cells,
            [fieldId]: {
              ...target,
              value: newValue,
              status: 'ok',
              reason: '已人工确认修改',
            },
          },
        };
      })
    );
  }

  function handleDeleteRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  async function handleWriteToTable() {
    if (!adapter || !schema || rows.length === 0) return;
    setWriting(true);
    setMessage(null);
    try {
      const { writtenCount } = await adapter.writeValidatedRows(schema, rows);
      setMessage({
        type: 'success',
        text: isMock
          ? `模拟写入成功！共写入 ${writtenCount} 条记录到「${schema.tableName}」（接入飞书侧边栏后将直接写入真实多维表格）。`
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
        <div>
          <h1>AnyToSheet 万物入表</h1>
          <p className="subtitle">自动读取表头 · 扫描版 PDF 转高清图 · 附件列批量提取 · 异常标黄复核</p>
        </div>
        <span className={`badge ${isMock ? 'badge-mock' : 'badge-live'}`}>
          {isMock ? '本地演示模式' : '飞书已连接'}
        </span>
      </header>

      {/* Step 1: Target Table Schema */}
      <section className="card">
        <div className="card-header">
          <strong>1. 目标表头（自动感知）</strong>
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
            <button className="btn btn-ghost" onClick={() => handleRefreshSchema()}>
              刷新表头
            </button>
          </div>
        </div>
        {schema ? (
          <>
            <div className="table-title">当前数据表：{schema.tableName}</div>
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

      {/* Step 2: Input Source (Local Upload / PDF vs Feishu Attachment Column) */}
      <section className="card">
        <div className="card-header">
          <strong>2. 选择待识别文件</strong>
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
              读取表格附件列
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
                handleFileChange(e.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.csv,.json"
                style={{ display: 'none' }}
                onChange={(e) => handleFileChange(e.target.files)}
              />
              <div>点击选择或拖入 图片 / 微信截图 / PDF（含扫描件）/ 文本</div>
              <small>PDF 将在浏览器本地自动逐页转为高清图再识别，一份多明细单据自动拆多行</small>
            </div>

            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, idx) => (
                  <li key={`${f.name}-${idx}`}>
                    <span>
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
                    style={{ flex: 1 }}
                    value={selectedAttFieldId}
                    onChange={(e) => setSelectedAttFieldId(e.target.value)}
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
                            <span>
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
                    点击「一键扫描附件列」，即可批量读取表格附件列里的 PDF / 图片直接提取。
                  </div>
                )}
              </>
            ) : (
              <div className="muted">
                当前表格暂未检测到「附件」类型的列，请在多维表格中添加附件列后点「刷新表头」，或切回「本地上传 / PDF」。
              </div>
            )}
          </div>
        )}

        <div className="options-row">
          <input
            className="hint-input"
            style={{ flex: 1 }}
            type="text"
            placeholder="可选说明（例如：只提取含税金额 / 跳过表尾总计行）"
            value={userHint}
            onChange={(e) => setUserHint(e.target.value)}
          />
          <label className="pdf-limit">
            PDF 上限
            <select
              className="select"
              value={maxPdfPages}
              onChange={(e) => setMaxPdfPages(Number(e.target.value))}
            >
              <option value={3}>3 页/份</option>
              <option value={5}>5 页/份</option>
              <option value={10}>10 页/份</option>
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
            <strong>
              3. 提取预览与复核（{rows.length} 条
              {warningCount > 0 ? `，${warningCount} 处标黄待复核` : '，全部校验通过'}）
            </strong>
            {extractResult && extractResult.mode === 'llm' && (
              <span className="muted">预估成本 ¥{extractResult.estimatedCostCny}</span>
            )}
          </div>

          <div className="preview-table-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>来源文件</th>
                  {writableFields.map((f) => (
                    <th key={f.id}>{f.name}</th>
                  ))}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <React.Fragment key={row.rowId}>
                    <tr>
                      <td className="source-cell" title={row.sourceFileName}>
                        {row.sourceFileName}
                      </td>
                      {writableFields.map((f) => {
                        const cell = row.cells[f.id];
                        const displayVal = Array.isArray(cell?.value)
                          ? cell.value.join(', ')
                          : cell?.value ?? '';
                        const isWarn = cell && cell.status !== 'ok';
                        return (
                          <td
                            key={f.id}
                            className={isWarn ? 'cell-warning' : ''}
                            title={
                              cell?.reason ||
                              `置信度 ${Math.round((cell?.confidence ?? 0.9) * 100)}%`
                            }
                          >
                            <input
                              className="cell-input"
                              value={String(displayVal)}
                              onChange={(e) => handleCellEdit(row.rowId, f.id, e.target.value)}
                            />
                          </td>
                        );
                      })}
                      <td>
                        <button className="link-danger" onClick={() => handleDeleteRow(row.rowId)}>
                          删行
                        </button>
                      </td>
                    </tr>
                    {row.rowWarnings.length > 0 && (
                      <tr className="row-warning-banner">
                        <td colSpan={writableFields.length + 2}>
                          ⚠️ {row.rowWarnings.join(' ｜ ')}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn btn-success btn-block"
            disabled={writing || rows.length === 0}
            onClick={handleWriteToTable}
          >
            {writing ? '正在写入表格...' : `一键批量写入表格（${rows.length} 条）`}
          </button>
        </section>
      )}
    </div>
  );
}

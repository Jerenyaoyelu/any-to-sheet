import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DOC_TEMPLATE_PRESETS,
  renderDeliverableHtml,
  type DocTemplateId,
  type HostAdapter,
  type TableRecordRow,
  type TableSchema,
} from '@table-ai/core';

interface DocGenTabProps {
  adapter: HostAdapter | null;
  schema: TableSchema | null;
}

const ISSUER_STORAGE_KEY = 'any_to_sheet_doc_issuer';
const FOOTER_STORAGE_KEY = 'any_to_sheet_doc_footer';
const A4_RENDER_WIDTH = 780;

function formatLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function guessDefaultTemplate(schema: TableSchema | null): {
  templateId: DocTemplateId;
  title: string;
  recipientCol: string;
} {
  if (!schema) return { templateId: 'quotation', title: '产品/服务报价单', recipientCol: '' };
  const names = schema.fields.map((f) => f.name).join(' ');
  const isHr = /候选人|简历|应聘|学历|员工|入职/.test(`${schema.tableName} ${names}`);
  if (isHr) {
    const nameField = schema.fields.find((f) => /姓名|候选人|员工/.test(f.name))?.name || '';
    return { templateId: 'per_row_card', title: '录用 / 面试通知单', recipientCol: nameField };
  }
  const vendorField = schema.fields.find((f) => /供应商|客户|商户|收款方/.test(f.name))?.name || '';
  return { templateId: 'quotation', title: '产品/服务报价单', recipientCol: vendorField };
}

export default function DocGenTab({ adapter, schema }: DocGenTabProps) {
  const readableFields = useMemo(
    () => schema?.fields.filter((f) => f.rawType !== 17) ?? [],
    [schema]
  );
  const headers = useMemo(() => readableFields.map((f) => f.name), [readableFields]);
  const schemaSig = useMemo(
    () => `${schema?.tableId || ''}::${readableFields.map((f) => f.id).join(',')}`,
    [schema?.tableId, readableFields]
  );

  const [records, setRecords] = useState<TableRecordRow[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [visibleHeaders, setVisibleHeaders] = useState<string[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [templateId, setTemplateId] = useState<DocTemplateId>('quotation');
  const [docTitle, setDocTitle] = useState('产品/服务报价单');
  const [titleEditedByUser, setTitleEditedByUser] = useState(false);
  const [issuerName, setIssuerName] = useState(
    () => window.localStorage.getItem(ISSUER_STORAGE_KEY) || ''
  );
  const [recipientName, setRecipientName] = useState('');
  const [recipientFieldCol, setRecipientFieldCol] = useState('');
  const [groupByCol, setGroupByCol] = useState('');
  const [footerNote, setFooterNote] = useState(
    () => window.localStorage.getItem(FOOTER_STORAGE_KEY) || ''
  );
  const [customBody, setCustomBody] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  const [previewScale, setPreviewScale] = useState(0.45);
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null
  );

  const previewOuterRef = useRef<HTMLDivElement>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const customTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Measure sidebar container width so A4 iframe scales cleanly with zero horizontal overflow
  useEffect(() => {
    const el = previewOuterRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateScale = () => {
      const width = el.clientWidth;
      if (width > 0) {
        setPreviewScale(Math.min(1, width / A4_RENDER_WIDTH));
      }
    };
    updateScale();
    const ro = new ResizeObserver(updateScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showPreview, records.length]);

  // Reload records & reset table-specific column bindings whenever table changes
  useEffect(() => {
    if (!adapter?.readTableRecords || !schema) return;
    let cancelled = false;
    setLoadingRows(true);
    setNotice(null);

    const guess = guessDefaultTemplate(schema);
    setTemplateId(guess.templateId);
    setDocTitle(guess.title);
    setTitleEditedByUser(false);
    setRecipientFieldCol(guess.recipientCol);
    setGroupByCol('');

    const cols = schema.fields.filter((f) => f.rawType !== 17).map((f) => f.name);
    setVisibleHeaders(cols);
    setCustomBody(
      `您好：\n\n以下为本次确认的详细信息：\n\n${cols.map((c) => `${c}：{{${c}}}`).join('\n')}\n\n请核对无误后回复确认。`
    );

    adapter
      .readTableRecords(schema.tableId, 200)
      .then((res) => {
        if (cancelled) return;
        setRecords(res.records);
        setSelectedRecordIds(res.records.map((r) => r.recordId));
      })
      .catch((err) => {
        if (!cancelled) {
          setNotice({
            type: 'error',
            text: err instanceof Error ? err.message : '读取表格行失败',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, schemaSig]);

  function handleIssuerChange(val: string) {
    setIssuerName(val);
    window.localStorage.setItem(ISSUER_STORAGE_KEY, val);
  }

  function handleFooterChange(val: string) {
    setFooterNote(val);
    window.localStorage.setItem(FOOTER_STORAGE_KEY, val);
  }

  function handleTemplateChange(nextId: DocTemplateId) {
    setTemplateId(nextId);
    // Only update title if user hasn't manually customized it
    if (!titleEditedByUser) {
      const preset = DOC_TEMPLATE_PRESETS.find((p) => p.id === nextId);
      if (preset) setDocTitle(preset.defaultTitle);
    }
  }

  function toggleVisibleHeader(name: string) {
    setVisibleHeaders((prev) => {
      if (prev.includes(name)) {
        if (prev.length <= 1) return prev; // Keep at least 1 column
        return prev.filter((h) => h !== name);
      }
      return headers.filter((h) => prev.includes(h) || h === name);
    });
  }

  function toggleRecord(id: string) {
    setSelectedRecordIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  /** Inserts {{column}} at the current cursor position in custom template textarea */
  function insertPlaceholderAtCursor(colName: string) {
    const token = `{{${colName}}}`;
    const el = customTextareaRef.current;
    if (!el) {
      setCustomBody((prev) => `${prev}${token}`);
      return;
    }
    const start = el.selectionStart ?? customBody.length;
    const end = el.selectionEnd ?? customBody.length;
    const next = customBody.slice(0, start) + token + customBody.slice(end);
    setCustomBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const selectedRowsData = useMemo(() => {
    const idSet = new Set(selectedRecordIds);
    return records
      .filter((r) => idSet.has(r.recordId))
      .map((r) => {
        const obj: Record<string, string> = {};
        for (const f of readableFields) {
          const v = r.values[f.id];
          obj[f.name] = Array.isArray(v) ? v.join('、') : v == null ? '' : String(v);
        }
        return obj;
      });
  }, [records, selectedRecordIds, readableFields]);

  const generatedHtml = useMemo(() => {
    if (selectedRowsData.length === 0) return '';
    return renderDeliverableHtml(headers, selectedRowsData, {
      templateId,
      docTitle,
      issuerName,
      recipientName,
      recipientFieldCol: recipientFieldCol || undefined,
      groupByCol: groupByCol || undefined,
      visibleHeaders,
      footerNote,
      customBodyTemplate: customBody,
    });
  }, [
    headers,
    selectedRowsData,
    templateId,
    docTitle,
    issuerName,
    recipientName,
    recipientFieldCol,
    groupByCol,
    visibleHeaders,
    footerNote,
    customBody,
  ]);

  /** No-popup printing via embedded preview iframe (works reliably inside Feishu Desktop Client!) */
  function handlePrintPdf() {
    if (!generatedHtml) return;
    const frameWin = previewIframeRef.current?.contentWindow;
    if (frameWin) {
      try {
        frameWin.focus();
        frameWin.print();
        return;
      } catch {
        // fallback below
      }
    }
    const win = window.open('', '_blank', 'width=900,height=720');
    if (!win) {
      setNotice({
        type: 'info',
        text: '飞书客户端限制了直接弹窗打印，请点「下载 Word (.doc)」或「下载 HTML」后用浏览器/WPS 一键另存为 PDF。',
      });
      return;
    }
    win.document.open();
    win.document.write(generatedHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }

  function handleDownload(ext: 'doc' | 'html') {
    if (!generatedHtml) return;
    const mime =
      ext === 'doc' ? 'application/msword;charset=utf-8' : 'text/html;charset=utf-8';
    const blob = new Blob(['\uFEFF', generatedHtml], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docTitle || '业务单据'}_${formatLocalDate()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setNotice({
      type: 'success',
      text: `已导出 ${selectedRowsData.length} 条记录生成的 .${ext} 文档！`,
    });
  }

  const primaryField = readableFields[0];
  const isSummaryTemplate = templateId === 'quotation' || templateId === 'statement';

  return (
    <div className="tab-stack">
      <section className="card">
        <div className="card-header">
          <strong>单据模板与落款设置</strong>
          <span className="muted">本地排版 · 0 额度</span>
        </div>

        <select
          className="select"
          value={templateId}
          onChange={(e) => handleTemplateChange(e.target.value as DocTemplateId)}
        >
          {DOC_TEMPLATE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <div className="muted">
          {DOC_TEMPLATE_PRESETS.find((p) => p.id === templateId)?.description}
        </div>

        <div className="form-grid">
          <input
            className="hint-input"
            placeholder="单据标题（如：2026年11月报价单）"
            value={docTitle}
            onChange={(e) => {
              setDocTitle(e.target.value);
              setTitleEditedByUser(true);
            }}
          />
          <input
            className="hint-input"
            placeholder="出具方 / 我方公司名（自动记忆）"
            value={issuerName}
            onChange={(e) => handleIssuerChange(e.target.value)}
          />
          {isSummaryTemplate ? (
            <select
              className="select"
              value={groupByCol}
              onChange={(e) => setGroupByCol(e.target.value)}
            >
              <option value="">合并为 1 份总单据（不拆单）</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  按「{h}」自动分组拆单
                </option>
              ))}
            </select>
          ) : (
            <select
              className="select"
              value={recipientFieldCol}
              onChange={(e) => setRecipientFieldCol(e.target.value)}
            >
              <option value="">接收方：使用右侧固定名称</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  接收方按行绑定「{h}」
                </option>
              ))}
            </select>
          )}
          <input
            className="hint-input"
            placeholder={
              !isSummaryTemplate && recipientFieldCol
                ? `已按行绑定「${recipientFieldCol}」`
                : '固定接收方名称（可选）'
            }
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
          />
        </div>

        <input
          className="hint-input"
          placeholder="底部备注（自动记忆，可选）"
          value={footerNote}
          onChange={(e) => handleFooterChange(e.target.value)}
        />

        {templateId !== 'custom' && headers.length > 0 && (
          <div>
            <div className="sub-label">勾选输出列（可取消勾选以隐藏内部成本/敏感列）：</div>
            <div className="col-picker">
              {headers.map((h) => {
                const on = visibleHeaders.includes(h);
                return (
                  <label key={h} className={`col-chip ${on ? 'col-chip-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleVisibleHeader(h)}
                    />
                    <span>{h}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {templateId === 'custom' && (
          <div className="att-panel">
            <div className="sub-label">点击变量芯片插入到光标处（按行自动替换）：</div>
            <div className="preset-chips">
              {headers.map((h) => (
                <button
                  key={h}
                  className="preset-chip"
                  onClick={() => insertPlaceholderAtCursor(h)}
                >
                  + {h}
                </button>
              ))}
            </div>
            <textarea
              ref={customTextareaRef}
              className="textarea"
              rows={8}
              style={{ minHeight: 168 }}
              value={customBody}
              onChange={(e) => setCustomBody(e.target.value)}
            />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <strong>
            勾选要生成的记录（{selectedRecordIds.length}/{records.length} 行）
          </strong>
          <button
            className="btn btn-ghost"
            onClick={() =>
              setSelectedRecordIds(
                selectedRecordIds.length === records.length ? [] : records.map((r) => r.recordId)
              )
            }
          >
            {selectedRecordIds.length === records.length ? '全不选' : '全选'}
          </button>
        </div>

        {loadingRows ? (
          <div className="muted">正在读取表格记录...</div>
        ) : records.length === 0 ? (
          <div className="muted">当前表暂无记录，请先在「万物入表」写入数据。</div>
        ) : (
          <ul className="file-list" style={{ maxHeight: 150, overflowY: 'auto' }}>
            {records.map((rec, idx) => {
              const checked = selectedRecordIds.includes(rec.recordId);
              const previewLabel = primaryField
                ? String(rec.values[primaryField.id] ?? `第 ${idx + 1} 行`)
                : `第 ${idx + 1} 行`;
              return (
                <li key={rec.recordId}>
                  <label className="att-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRecord(rec.recordId)}
                    />
                    <span className="file-name">
                      #{idx + 1} {previewLabel}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {notice && <div className={`alert alert-${notice.type}`}>{notice.text}</div>}

      {generatedHtml && (
        <section className="card">
          <div className="card-header">
            <strong>A4 实时预览与导出</strong>
            <button className="btn btn-ghost" onClick={() => setShowPreview((p) => !p)}>
              {showPreview ? '收起预览' : '展开预览'}
            </button>
          </div>

          {showPreview && (
            <div ref={previewOuterRef} className="a4-preview-outer">
              <div
                className="a4-preview-scaler"
                style={{
                  width: A4_RENDER_WIDTH,
                  height: 760,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              >
                <iframe
                  ref={previewIframeRef}
                  className="a4-preview-iframe"
                  title="文档预览"
                  sandbox="allow-same-origin allow-modals"
                  srcDoc={generatedHtml}
                />
              </div>
              {/* Reserve exact scaled visual height so there is zero dead gap or horizontal scroll */}
              <div style={{ height: Math.round(760 * previewScale) }} />
            </div>
          )}

          <div className="export-actions">
            <button className="btn btn-primary" onClick={handlePrintPdf}>
              导出 / 打印 PDF
            </button>
            <button className="btn btn-success" onClick={() => handleDownload('doc')}>
              下载 Word (.doc)
            </button>
            <button className="btn btn-ghost" onClick={() => handleDownload('html')}>
              下载 HTML
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

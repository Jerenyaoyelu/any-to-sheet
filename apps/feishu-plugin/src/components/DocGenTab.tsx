import React, { useEffect, useMemo, useState } from 'react';
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

export default function DocGenTab({ adapter, schema }: DocGenTabProps) {
  const writableFields = useMemo(
    () => schema?.fields.filter((f) => !f.readonly && f.type !== 'unknown') ?? [],
    [schema]
  );

  const [records, setRecords] = useState<TableRecordRow[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [templateId, setTemplateId] = useState<DocTemplateId>('quotation');
  const [docTitle, setDocTitle] = useState('产品/服务报价单');
  const [issuerName, setIssuerName] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [footerNote, setFooterNote] = useState('');
  const [customBody, setCustomBody] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    if (!adapter?.readTableRecords || !schema) return;
    let cancelled = false;
    setLoadingRows(true);

    adapter
      .readTableRecords(schema.tableId, 100)
      .then((res) => {
        if (cancelled) return;
        setRecords(res.records);
        setSelectedRecordIds(res.records.map((r) => r.recordId));
        if (!customBody && res.schema.fields.length > 0) {
          const cols = res.schema.fields
            .filter((f) => !f.readonly && f.type !== 'unknown')
            .map((f) => `${f.name}：{{${f.name}}}`);
          setCustomBody(`您好：\n\n以下为本次确认的详细信息：\n\n${cols.join('\n')}\n\n请核对无误后回复确认。`);
        }
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
  }, [adapter, schema?.tableId]);

  function handleTemplateChange(nextId: DocTemplateId) {
    setTemplateId(nextId);
    const preset = DOC_TEMPLATE_PRESETS.find((p) => p.id === nextId);
    if (preset) setDocTitle(preset.defaultTitle);
  }

  function toggleRecord(id: string) {
    setSelectedRecordIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const headers = useMemo(() => writableFields.map((f) => f.name), [writableFields]);

  const selectedRowsData = useMemo(() => {
    const idSet = new Set(selectedRecordIds);
    return records
      .filter((r) => idSet.has(r.recordId))
      .map((r) => {
        const obj: Record<string, string> = {};
        for (const f of writableFields) {
          const v = r.values[f.id];
          obj[f.name] = Array.isArray(v) ? v.join('、') : v == null ? '' : String(v);
        }
        return obj;
      });
  }, [records, selectedRecordIds, writableFields]);

  const generatedHtml = useMemo(() => {
    if (selectedRowsData.length === 0) return '';
    return renderDeliverableHtml(headers, selectedRowsData, {
      templateId,
      docTitle,
      issuerName,
      recipientName,
      footerNote,
      customBodyTemplate: customBody,
    });
  }, [headers, selectedRowsData, templateId, docTitle, issuerName, recipientName, footerNote, customBody]);

  function handlePrintPdf() {
    if (!generatedHtml) return;
    const win = window.open('', '_blank', 'width=900,height=720');
    if (!win) {
      setNotice({
        type: 'error',
        text: '浏览器拦截了打印窗口，请允许弹窗或改点「下载 Word / HTML」后直接打开打印为 PDF。',
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
    a.download = `${docTitle || '业务单据'}_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice({
      type: 'success',
      text: `已导出 ${selectedRowsData.length} 条记录生成的 .${ext} 文档！`,
    });
  }

  const primaryField = writableFields[0];

  return (
    <div className="tab-stack">
      <section className="card">
        <div className="card-header">
          <strong>1. 选择单据模板与落款信息</strong>
          <span className="muted">免费本地排版 · 0 额度</span>
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
            onChange={(e) => setDocTitle(e.target.value)}
          />
          <input
            className="hint-input"
            placeholder="出具方 / 我方公司名称"
            value={issuerName}
            onChange={(e) => setIssuerName(e.target.value)}
          />
          <input
            className="hint-input"
            placeholder="接收方 / 客户或候选人名称"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
          />
          <input
            className="hint-input"
            placeholder="底部备注（可选）"
            value={footerNote}
            onChange={(e) => setFooterNote(e.target.value)}
          />
        </div>

        {templateId === 'custom' && (
          <div className="att-panel">
            <div className="sub-label">点击插入字段变量（自动按行替换）：</div>
            <div className="preset-chips">
              {headers.map((h) => (
                <button
                  key={h}
                  className="preset-chip"
                  onClick={() => setCustomBody((prev) => `${prev}{{${h}}}`)}
                >
                  + {h}
                </button>
              ))}
            </div>
            <textarea
              className="textarea"
              rows={5}
              value={customBody}
              onChange={(e) => setCustomBody(e.target.value)}
            />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <strong>
            2. 勾选要生成的记录（{selectedRecordIds.length}/{records.length} 行）
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
          <ul className="file-list" style={{ maxHeight: 160, overflowY: 'auto' }}>
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
            <strong>3. 实时排版预览与导出</strong>
            <button className="btn btn-ghost" onClick={() => setShowPreview((p) => !p)}>
              {showPreview ? '收起预览' : '展开预览'}
            </button>
          </div>

          {showPreview && (
            <iframe
              className="doc-preview-frame"
              title="文档预览"
              sandbox="allow-same-origin"
              srcDoc={generatedHtml}
            />
          )}

          <div className="export-actions">
            <button className="btn btn-primary" onClick={handlePrintPdf}>
              导出 / 打印高清 PDF
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

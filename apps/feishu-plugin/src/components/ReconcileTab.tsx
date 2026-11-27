import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildReconcileCsvReport,
  parseDelimitedTable,
  reconcileTables,
  suggestReconcileMapping,
  type HostAdapter,
  type ReconcileColumnPair,
  type ReconcileStatus,
  type ReconcileSummary,
  type SimpleTableData,
  type TableSchema,
  type TableSummary,
} from '@table-ai/core';

interface ReconcileTabProps {
  adapter: HostAdapter | null;
  schema: TableSchema | null;
}

type RightSourceMode = 'bitable' | 'paste' | 'csv';

function recordsToSimpleTable(
  schema: TableSchema,
  records: Array<{ recordId: string; values: Record<string, unknown> }>
): SimpleTableData {
  const writable = schema.fields.filter((f) => !f.readonly && f.type !== 'unknown');
  const headers = writable.map((f) => f.name);
  const rows = records.map((r) => {
    const obj: Record<string, string> = {};
    for (const f of writable) {
      const val = r.values[f.id];
      obj[f.name] = Array.isArray(val) ? val.join(', ') : val == null ? '' : String(val);
    }
    return obj;
  });
  return { name: schema.tableName, headers, rows };
}

export default function ReconcileTab({ adapter, schema }: ReconcileTabProps) {
  const [leftTable, setLeftTable] = useState<SimpleTableData | null>(null);
  const [otherTables, setOtherTables] = useState<TableSummary[]>([]);

  const [rightMode, setRightMode] = useState<RightSourceMode>('bitable');
  const [rightTableId, setRightTableId] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [rightTable, setRightTable] = useState<SimpleTableData | null>(null);

  const [leftKeyCol, setLeftKeyCol] = useState('');
  const [rightKeyCol, setRightKeyCol] = useState('');
  const [comparePairs, setComparePairs] = useState<ReconcileColumnPair[]>([]);
  const [tolerance, setTolerance] = useState(0.05);

  const [loading, setLoading] = useState(false);
  const [aiMatching, setAiMatching] = useState(false);
  const [summary, setSummary] = useState<ReconcileSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | ReconcileStatus>('all');
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null
  );

  const csvInputRef = useRef<HTMLInputElement>(null);

  // Load left table (active table) and list sibling tables in the same Base
  useEffect(() => {
    if (!adapter?.readTableRecords || !schema) return;
    let cancelled = false;
    setLoading(true);
    setSummary(null);

    Promise.all([
      adapter.readTableRecords(schema.tableId, 300),
      adapter.listTables ? adapter.listTables() : Promise.resolve([]),
    ])
      .then(([leftRes, tables]) => {
        if (cancelled) return;
        const leftData = recordsToSimpleTable(leftRes.schema, leftRes.records);
        setLeftTable(leftData);
        const siblings = tables.filter((t) => t.tableId !== schema.tableId);
        setOtherTables(siblings);
        if (siblings.length > 0) {
          setRightTableId((prev) =>
            siblings.some((s) => s.tableId === prev) ? prev : siblings[0].tableId
          );
        } else {
          setRightMode('paste');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setNotice({
            type: 'error',
            text: err instanceof Error ? err.message : '读取当前表数据失败',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, schema?.tableId]);

  // Auto-load sibling table B when selected
  useEffect(() => {
    if (rightMode !== 'bitable' || !rightTableId || !adapter?.readTableRecords) return;
    let cancelled = false;
    adapter
      .readTableRecords(rightTableId, 300)
      .then((res) => {
        if (cancelled) return;
        const data = recordsToSimpleTable(res.schema, res.records);
        setRightTable(data);
        setSummary(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setNotice({
            type: 'error',
            text: err instanceof Error ? err.message : '读取对照表失败',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, rightMode, rightTableId]);

  // Auto-suggest column mapping whenever left or right headers change
  useEffect(() => {
    if (!leftTable || !rightTable || leftTable.headers.length === 0 || rightTable.headers.length === 0) {
      return;
    }
    const suggested = suggestReconcileMapping(leftTable.headers, rightTable.headers);
    setLeftKeyCol(suggested.leftKeyCol);
    setRightKeyCol(suggested.rightKeyCol);
    setComparePairs(suggested.comparePairs);
  }, [leftTable?.name, leftTable?.headers.join('|'), rightTable?.name, rightTable?.headers.join('|')]);

  function handleParsePaste() {
    const parsed = parseDelimitedTable(pasteText, '粘贴的外部表格');
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setNotice({ type: 'error', text: '未解析到有效表头和行数据，请从 Excel/WPS 复制含表头的区域后粘贴。' });
      return;
    }
    setRightTable(parsed);
    setSummary(null);
    setNotice({
      type: 'info',
      text: `已解析外部表格：${parsed.headers.length} 列，${parsed.rows.length} 行数据，已自动推荐对账字段。`,
    });
  }

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const parsed = parseDelimitedTable(text, file.name);
      if (parsed.headers.length === 0) {
        setNotice({ type: 'error', text: 'CSV 文件为空或格式无法解析' });
        return;
      }
      setRightTable(parsed);
      setSummary(null);
      setNotice({
        type: 'info',
        text: `已载入「${file.name}」：${parsed.headers.length} 列，${parsed.rows.length} 行。`,
      });
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  async function handleAiSuggestMapping() {
    if (!leftTable || !rightTable) return;
    setAiMatching(true);
    setNotice(null);
    try {
      const res = await fetch('/api/reconcile-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leftHeaders: leftTable.headers,
          rightHeaders: rightTable.headers,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '列名对齐失败');
      const m = data.mapping as {
        leftKeyCol: string;
        rightKeyCol: string;
        comparePairs: ReconcileColumnPair[];
      };
      setLeftKeyCol(m.leftKeyCol);
      setRightKeyCol(m.rightKeyCol);
      setComparePairs(m.comparePairs);
      setNotice({
        type: 'success',
        text: `已自动对齐主键「${m.leftKeyCol} ↔ ${m.rightKeyCol}」及 ${m.comparePairs.length} 组比对列（${data.mode === 'llm' ? 'AI 语义识别' : '规则匹配'}）。`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'AI 对齐列名失败',
      });
    } finally {
      setAiMatching(false);
    }
  }

  function handleAddComparePair() {
    if (!leftTable || !rightTable) return;
    setComparePairs((prev) => [
      ...prev,
      { leftCol: leftTable.headers[0] || '', rightCol: rightTable.headers[0] || '' },
    ]);
  }

  function handleRunReconcile() {
    if (!leftTable || !rightTable || !leftKeyCol || !rightKeyCol) return;
    const result = reconcileTables(leftTable, rightTable, {
      leftKeyCol,
      rightKeyCol,
      comparePairs,
      numericTolerance: tolerance,
    });
    setSummary(result);
    setStatusFilter(
      result.mismatchCount > 0 || result.onlyInLeftCount > 0 || result.onlyInRightCount > 0
        ? 'all'
        : 'matched'
    );
    setNotice(null);
  }

  function handleExportCsv() {
    if (!summary) return;
    const csv = buildReconcileCsvReport(summary);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `对账差异报告_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredResults = useMemo(() => {
    if (!summary) return [];
    if (statusFilter === 'all') return summary.results;
    return summary.results.filter((r) => r.status === statusFilter);
  }, [summary, statusFilter]);

  return (
    <div className="tab-stack">
      <section className="card">
        <div className="card-header">
          <strong>1. 选择对照表（表 B）</strong>
          <div className="tabs">
            {otherTables.length > 0 && (
              <button
                className={`tab ${rightMode === 'bitable' ? 'tab-active' : ''}`}
                onClick={() => setRightMode('bitable')}
              >
                同文档另一张表
              </button>
            )}
            <button
              className={`tab ${rightMode === 'paste' ? 'tab-active' : ''}`}
              onClick={() => setRightMode('paste')}
            >
              粘贴 Excel
            </button>
            <button
              className={`tab ${rightMode === 'csv' ? 'tab-active' : ''}`}
              onClick={() => setRightMode('csv')}
            >
              上传 CSV
            </button>
          </div>
        </div>

        <div className="muted">
          左表（表 A）：<strong>{leftTable?.name || schema?.tableName || '-'}</strong>（{leftTable?.rows.length ?? 0} 行）
        </div>

        {rightMode === 'bitable' && otherTables.length > 0 && (
          <select
            className="select"
            value={rightTableId}
            onChange={(e) => setRightTableId(e.target.value)}
          >
            {otherTables.map((t) => (
              <option key={t.tableId} value={t.tableId}>
                右表（表 B）：{t.tableName}
              </option>
            ))}
          </select>
        )}

        {rightMode === 'paste' && (
          <div className="att-panel">
            <textarea
              className="textarea"
              rows={4}
              placeholder="直接从 Excel / WPS 选中区域按 Ctrl+C 复制，粘贴到这里（首行需为表头）..."
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <button
              className="btn btn-ghost"
              disabled={!pasteText.trim()}
              onClick={handleParsePaste}
            >
              解析粘贴内容为表 B
            </button>
          </div>
        )}

        {rightMode === 'csv' && (
          <div>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              style={{ display: 'none' }}
              onChange={handleCsvUpload}
            />
            <button className="btn btn-ghost btn-block" onClick={() => csvInputRef.current?.click()}>
              选择本地 CSV / TSV 对账文件
            </button>
          </div>
        )}
      </section>

      {leftTable && rightTable && rightTable.headers.length > 0 && (
        <section className="card">
          <div className="card-header">
            <strong>2. 对齐主键与核对列</strong>
            <button
              className="btn btn-ghost"
              disabled={aiMatching}
              onClick={handleAiSuggestMapping}
            >
              {aiMatching ? '对齐中...' : 'AI 智能对齐列名'}
            </button>
          </div>

          <div className="sub-label">对账主键（两表按哪一列匹配同一笔记录）：</div>
          <div className="pair-row">
            <select className="select" value={leftKeyCol} onChange={(e) => setLeftKeyCol(e.target.value)}>
              {leftTable.headers.map((h) => (
                <option key={h} value={h}>
                  表A: {h}
                </option>
              ))}
            </select>
            <span className="muted">↔</span>
            <select className="select" value={rightKeyCol} onChange={(e) => setRightKeyCol(e.target.value)}>
              {rightTable.headers.map((h) => (
                <option key={h} value={h}>
                  表B: {h}
                </option>
              ))}
            </select>
          </div>

          <div className="card-header" style={{ marginTop: 4 }}>
            <span className="sub-label">要核对差异的列（如金额、数量）：</span>
            <button className="btn btn-ghost" onClick={handleAddComparePair}>
              + 添加比对列
            </button>
          </div>

          {comparePairs.map((pair, idx) => (
            <div key={idx} className="pair-row">
              <select
                className="select"
                value={pair.leftCol}
                onChange={(e) =>
                  setComparePairs((prev) =>
                    prev.map((p, i) => (i === idx ? { ...p, leftCol: e.target.value } : p))
                  )
                }
              >
                {leftTable.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span className="muted">vs</span>
              <select
                className="select"
                value={pair.rightCol}
                onChange={(e) =>
                  setComparePairs((prev) =>
                    prev.map((p, i) => (i === idx ? { ...p, rightCol: e.target.value } : p))
                  )
                }
              >
                {rightTable.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <button
                className="link-danger"
                onClick={() => setComparePairs((prev) => prev.filter((_, i) => i !== idx))}
              >
                删
              </button>
            </div>
          ))}

          <div className="options-row">
            <label className="pdf-limit">
              金额容差
              <select
                className="select"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
              >
                <option value={0}>严格相等 (0)</option>
                <option value={0.01}>允许 ±0.01</option>
                <option value={0.05}>允许 ±0.05</option>
                <option value={1}>允许 ±1.00</option>
              </select>
            </label>
          </div>

          <button
            className="btn btn-primary btn-block"
            disabled={loading || !leftKeyCol || !rightKeyCol}
            onClick={handleRunReconcile}
          >
            开始一键对账找茬（{leftTable.rows.length} 行 vs {rightTable.rows.length} 行）
          </button>
        </section>
      )}

      {notice && <div className={`alert alert-${notice.type}`}>{notice.text}</div>}

      {summary && (
        <section className="card">
          <div className="card-header">
            <strong>3. 对账差异报告</strong>
            <button className="btn btn-ghost" onClick={handleExportCsv}>
              导出 CSV 报告
            </button>
          </div>

          <div className="stat-grid">
            <button
              className={`stat-pill ${statusFilter === 'mismatch' ? 'stat-active' : ''} stat-warn`}
              onClick={() => setStatusFilter(statusFilter === 'mismatch' ? 'all' : 'mismatch')}
            >
              <strong>{summary.mismatchCount}</strong>
              <span>字段差异</span>
            </button>
            <button
              className={`stat-pill ${statusFilter === 'onlyInLeft' ? 'stat-active' : ''} stat-red`}
              onClick={() => setStatusFilter(statusFilter === 'onlyInLeft' ? 'all' : 'onlyInLeft')}
            >
              <strong>{summary.onlyInLeftCount}</strong>
              <span>表B缺失</span>
            </button>
            <button
              className={`stat-pill ${statusFilter === 'onlyInRight' ? 'stat-active' : ''} stat-blue`}
              onClick={() => setStatusFilter(statusFilter === 'onlyInRight' ? 'all' : 'onlyInRight')}
            >
              <strong>{summary.onlyInRightCount}</strong>
              <span>表A缺失</span>
            </button>
            <button
              className={`stat-pill ${statusFilter === 'matched' ? 'stat-active' : ''} stat-green`}
              onClick={() => setStatusFilter(statusFilter === 'matched' ? 'all' : 'matched')}
            >
              <strong>{summary.matchedCount}</strong>
              <span>完全一致</span>
            </button>
          </div>

          <div className="diff-list">
            {filteredResults.map((item, idx) => (
              <div key={`${item.key}-${idx}`} className={`reconcile-item rec-${item.status}`}>
                <div className="reconcile-head">
                  <strong>{item.key}</strong>
                  <span className={`rec-badge rec-badge-${item.status}`}>
                    {item.status === 'matched'
                      ? '一致'
                      : item.status === 'mismatch'
                        ? '有差异'
                        : item.status === 'onlyInLeft'
                          ? '仅表A有'
                          : '仅表B有'}
                  </span>
                </div>
                {item.diffs.length > 0 && (
                  <div className="reconcile-diffs">
                    {item.diffs.map((d, di) => (
                      <div key={di} className="reconcile-diff-line">
                        <span>{d.leftCol}：</span>
                        <span className="diff-before">{d.leftVal}</span>
                        <span> vs </span>
                        <span className="diff-after">{d.rightVal}</span>
                        {typeof d.numericDelta === 'number' && (
                          <strong className="delta-tag">
                            差额 {d.numericDelta > 0 ? '+' : ''}
                            {d.numericDelta}
                          </strong>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

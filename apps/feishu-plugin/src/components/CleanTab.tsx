import React, { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_CLEAN_PRESETS,
  computeCleanDiff,
  type CleanPreviewResult,
  type CleanRulePlan,
  type HostAdapter,
  type QuotaSnapshot,
  type TableRecordRow,
  type TableRecordUpdate,
  type TableSchema,
  type UserIdentity,
} from '@table-ai/core';

interface CleanTabProps {
  adapter: HostAdapter | null;
  schema: TableSchema | null;
  identity: UserIdentity | null;
  onQuotaUpdate: (quota: QuotaSnapshot) => void;
}

export default function CleanTab({
  adapter,
  schema,
  identity,
  onQuotaUpdate,
}: CleanTabProps) {
  const writableFields = useMemo(
    () => schema?.fields.filter((f) => !f.readonly && f.type !== 'unknown') ?? [],
    [schema]
  );

  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [records, setRecords] = useState<TableRecordRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [instruction, setInstruction] = useState('');
  const [activePlan, setActivePlan] = useState<CleanRulePlan | null>(null);
  const [preview, setPreview] = useState<CleanPreviewResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [lastRollback, setLastRollback] = useState<{
    schema: TableSchema;
    updates: TableRecordUpdate[];
    summary: string;
  } | null>(null);

  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null
  );

  // Sync default field & load live records when table changes
  useEffect(() => {
    if (!schema || !adapter?.readTableRecords) return;
    const firstId = writableFields[0]?.id || '';
    setSelectedFieldId((prev) =>
      writableFields.some((f) => f.id === prev) ? prev : firstId
    );
    setPreview(null);
    setActivePlan(null);
    setNotice(null);

    let cancelled = false;
    setLoadingRows(true);
    adapter
      .readTableRecords(schema.tableId, 200)
      .then((res) => {
        if (!cancelled) setRecords(res.records);
      })
      .catch((err) => {
        if (!cancelled) {
          setNotice({
            type: 'error',
            text: err instanceof Error ? err.message : '读取表格记录失败',
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

  const targetField = useMemo(
    () => writableFields.find((f) => f.id === selectedFieldId) || null,
    [writableFields, selectedFieldId]
  );

  async function reloadRecords() {
    if (!adapter?.readTableRecords || !schema) return;
    setLoadingRows(true);
    try {
      const res = await adapter.readTableRecords(schema.tableId, 200);
      setRecords(res.records);
      setPreview(null);
      setActivePlan(null);
      setNotice({ type: 'info', text: `已重新加载「${schema.tableName}」共 ${res.records.length} 行数据。` });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : '刷新记录失败',
      });
    } finally {
      setLoadingRows(false);
    }
  }

  function runPlanPreview(plan: CleanRulePlan) {
    if (!targetField) return;
    const result = computeCleanDiff(targetField, records, plan.steps);
    setActivePlan(plan);
    setPreview(result);
    setSelectedIds(result.diffs.map((d) => d.recordId));
    if (result.changedCount === 0) {
      setNotice({
        type: 'info',
        text: `已扫描 ${result.totalScanned} 行，「${targetField.name}」列无需改动（数据已经很干净，或可换个规则描述）。`,
      });
    } else {
      setNotice({
        type: 'info',
        text: `规则预览完成：共扫描 ${result.totalScanned} 行，将修改 ${result.changedCount} 个单元格。核对 Diff 后点击下方写入。`,
      });
    }
  }

  async function handleGenerateAiRules() {
    if (!targetField || !instruction.trim()) return;
    setGenerating(true);
    setNotice(null);
    try {
      const samples = records
        .map((r) => r.values[targetField.id])
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
        .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
        .slice(0, 20);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (identity?.userId) headers['x-user-id'] = identity.userId;
      if (identity?.tenantKey) headers['x-tenant-key'] = identity.tenantKey;

      const res = await fetch('/api/clean-rules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fieldName: targetField.name,
          fieldType: targetField.type,
          samples,
          instruction: instruction.trim(),
        }),
      });
      const data = await res.json();
      if (data.quota) onQuotaUpdate(data.quota as QuotaSnapshot);
      if (!res.ok) throw new Error(data.error || '生成清洗规则失败');

      const plan = data.plan as CleanRulePlan;
      runPlanPreview(plan);
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'AI 生成清洗规则失败',
      });
    } finally {
      setGenerating(false);
    }
  }

  function toggleDiffItem(recordId: string) {
    setSelectedIds((prev) =>
      prev.includes(recordId) ? prev.filter((id) => id !== recordId) : [...prev, recordId]
    );
  }

  async function handleApplyClean() {
    if (!adapter?.updateTableRecords || !schema || !preview || selectedIds.length === 0) return;
    setApplying(true);
    setNotice(null);
    try {
      const chosenSet = new Set(selectedIds);
      const applyUpdates = preview.applyUpdates.filter((u) => chosenSet.has(u.recordId));
      const rollbackUpdates = preview.rollbackUpdates.filter((u) => chosenSet.has(u.recordId));

      const { updatedCount } = await adapter.updateTableRecords(schema, applyUpdates);
      setLastRollback({
        schema,
        updates: rollbackUpdates,
        summary: activePlan?.summary || '上次清洗',
      });

      // Refresh local cached records so subsequent cleanups see updated data
      if (adapter.readTableRecords) {
        const fresh = await adapter.readTableRecords(schema.tableId, 200);
        setRecords(fresh.records);
      }

      setPreview(null);
      setActivePlan(null);
      setNotice({
        type: 'success',
        text: `清洗完成！已批量更新 ${updatedCount} 条记录。如需恢复原值，可随时点击下方「一键撤回」。`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : '写入清洗结果失败',
      });
    } finally {
      setApplying(false);
    }
  }

  async function handleRollback() {
    if (!adapter?.updateTableRecords || !lastRollback) return;
    setRollingBack(true);
    setNotice(null);
    try {
      const { updatedCount } = await adapter.updateTableRecords(
        lastRollback.schema,
        lastRollback.updates
      );
      if (adapter.readTableRecords && schema) {
        const fresh = await adapter.readTableRecords(schema.tableId, 200);
        setRecords(fresh.records);
      }
      setLastRollback(null);
      setNotice({
        type: 'success',
        text: `已一键撤回 ${updatedCount} 条记录至清洗前原值！`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : '撤回失败',
      });
    } finally {
      setRollingBack(false);
    }
  }

  return (
    <div className="tab-stack">
      <section className="card">
        <div className="card-header">
          <strong>1. 选择要清洗的列</strong>
          <button className="btn btn-ghost" disabled={loadingRows} onClick={reloadRecords}>
            {loadingRows ? '读取中...' : `已加载 ${records.length} 行 · 刷新`}
          </button>
        </div>

        <select
          className="select"
          value={selectedFieldId}
          onChange={(e) => {
            setSelectedFieldId(e.target.value);
            setPreview(null);
            setActivePlan(null);
          }}
        >
          {writableFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}（{f.type}）
            </option>
          ))}
        </select>

        <div>
          <div className="sub-label">快捷本地清洗（免费 · 0 额度 · 秒级本地执行）：</div>
          <div className="preset-chips">
            {BUILTIN_CLEAN_PRESETS.map((p) => (
              <button
                key={p.id}
                className="preset-chip"
                title={p.description}
                disabled={!targetField || records.length === 0}
                onClick={() => runPlanPreview(p.plan)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="divider-line" />

        <div>
          <div className="sub-label">AI 自定义清洗（仅耗 1 页额度生成规则，全列本地执行）：</div>
          <div className="att-toolbar">
            <input
              className="hint-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="例如：去掉括号里的备注，并把简称统一成公司全称"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={generating || !instruction.trim() || !targetField || records.length === 0}
              onClick={handleGenerateAiRules}
            >
              {generating ? '生成规则中...' : 'AI 生成 Diff'}
            </button>
          </div>
        </div>
      </section>

      {lastRollback && (
        <div className="rollback-bar">
          <span>上次操作：{lastRollback.summary}（{lastRollback.updates.length} 处）</span>
          <button
            className="btn btn-ghost"
            disabled={rollingBack}
            onClick={handleRollback}
          >
            {rollingBack ? '撤回中...' : '↩️ 一键撤回'}
          </button>
        </div>
      )}

      {notice && <div className={`alert alert-${notice.type}`}>{notice.text}</div>}

      {preview && preview.changedCount > 0 && (
        <section className="card">
          <div className="card-header">
            <strong>
              2. Git 式修改预览（{selectedIds.length}/{preview.changedCount} 处将生效）
            </strong>
            <div className="row-actions">
              <button
                className="btn btn-ghost"
                onClick={() =>
                  setSelectedIds(
                    selectedIds.length === preview.diffs.length
                      ? []
                      : preview.diffs.map((d) => d.recordId)
                  )
                }
              >
                {selectedIds.length === preview.diffs.length ? '全不选' : '全选'}
              </button>
            </div>
          </div>

          {activePlan && <div className="muted">规则说明：{activePlan.summary}</div>}

          <div className="diff-list">
            {preview.diffs.map((item) => {
              const checked = selectedIds.includes(item.recordId);
              return (
                <label key={item.recordId} className={`diff-card ${checked ? '' : 'diff-card-dim'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDiffItem(item.recordId)}
                  />
                  <div className="diff-body">
                    <div className="diff-before">- {item.before}</div>
                    <div className="diff-after">+ {item.after}</div>
                  </div>
                </label>
              );
            })}
          </div>

          <button
            className="btn btn-success btn-block"
            disabled={applying || selectedIds.length === 0}
            onClick={handleApplyClean}
          >
            {applying ? '正在写回表格...' : `一键应用到表格（${selectedIds.length} 处修改）`}
          </button>
        </section>
      )}
    </div>
  );
}

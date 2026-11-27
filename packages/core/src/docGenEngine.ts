import { parseNumberValue } from './validator.js';

export type DocTemplateId = 'quotation' | 'statement' | 'per_row_card' | 'custom';

export interface DocGenConfig {
  templateId: DocTemplateId;
  docTitle: string;
  issuerName: string;
  recipientName: string;
  footerNote: string;
  customBodyTemplate?: string;
}

export const DOC_TEMPLATE_PRESETS: Array<{
  id: DocTemplateId;
  name: string;
  mode: 'summary' | 'perRow';
  defaultTitle: string;
  description: string;
}> = [
  {
    id: 'quotation',
    name: '正式报价单（汇总明细）',
    mode: 'summary',
    defaultTitle: '产品/服务报价单',
    description: '将选中的多行记录汇总成 1 份带明细表、金额总计和盖章区的 A4 报价单',
  },
  {
    id: 'statement',
    name: '客户对账单（汇总明细）',
    mode: 'summary',
    defaultTitle: '月度业务对账单',
    description: '将选中的多行账目生成带总计和双方签字确认栏的正式对账单',
  },
  {
    id: 'per_row_card',
    name: '一客一单 / Offer / 通知书（每行一页）',
    mode: 'perRow',
    defaultTitle: '正式通知单',
    description: '选中的每一行独立生成一页排版卡片，适合批量发 Offer、录用函或客户凭证',
  },
  {
    id: 'custom',
    name: '自定义占位符模板（每行一页）',
    mode: 'perRow',
    defaultTitle: '定制业务单据',
    description: '自由使用 {{列名}} 占位符排版，按行批量替换生成',
  },
];

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function interpolateTemplate(template: string, row: Record<string, string>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey).trim();
    return escapeHtml(row[key] ?? '');
  });
}

function sumAmountColumn(headers: string[], rows: Array<Record<string, string>>): {
  colName: string;
  total: number;
} | null {
  const amountCol = headers.find((h) => /金额|总价|合计|实付|小计|total|amount/i.test(h));
  if (!amountCol) return null;
  let sum = 0;
  let found = false;
  for (const r of rows) {
    const n = parseNumberValue(r[amountCol]).value;
    if (n !== null) {
      sum += n;
      found = true;
    }
  }
  return found ? { colName: amountCol, total: Number(sum.toFixed(2)) } : null;
}

const PRINT_STYLES = `
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif;
    color: #1f2329;
    font-size: 13px;
    line-height: 1.6;
    background: #ffffff;
  }
  .page {
    max-width: 780px;
    margin: 0 auto 24px;
    padding: 28px 32px;
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    background: #fff;
  }
  .page-break { page-break-after: always; }
  .page-break:last-child { page-break-after: auto; }
  .doc-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 2px solid #1f2329;
    padding-bottom: 12px;
    margin-bottom: 18px;
  }
  .doc-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: 1px; }
  .doc-meta { font-size: 12px; color: #646a73; text-align: right; }
  .party-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    background: #f7f8fa;
    padding: 12px 14px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 12px;
  }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 16px; font-size: 12px; }
  th, td { border: 1px solid #d9dce3; padding: 8px 10px; text-align: left; }
  th { background: #f2f3f5; font-weight: 600; }
  .total-bar {
    text-align: right;
    font-size: 15px;
    font-weight: 700;
    padding: 10px 12px;
    background: #f0f5ff;
    border-radius: 6px;
    color: #1d4ed8;
    margin-bottom: 18px;
  }
  .kv-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 14px 0 20px;
  }
  .kv-item {
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    padding: 8px 12px;
  }
  .kv-label { font-size: 11px; color: #646a73; }
  .kv-val { font-size: 14px; font-weight: 600; margin-top: 2px; word-break: break-word; }
  .custom-body {
    white-space: pre-wrap;
    font-size: 14px;
    line-height: 1.85;
    padding: 12px 0 20px;
  }
  .sign-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-top: 28px;
    padding-top: 14px;
    border-top: 1px dashed #c9cdd4;
    font-size: 12px;
    color: #4e5969;
  }
  .footer-note { margin-top: 14px; font-size: 11px; color: #86909c; }
  @media print {
    body { padding: 0; }
    .page { border: none; padding: 0; margin: 0; max-width: none; }
  }
`;

export function renderDeliverableHtml(
  headers: string[],
  rows: Array<Record<string, string>>,
  config: DocGenConfig
): string {
  const todayStr = new Date().toISOString().slice(0, 10);
  const docNo = `ATS-${todayStr.replace(/-/g, '')}-${String(rows.length).padStart(2, '0')}`;
  const title = escapeHtml(config.docTitle || '业务单据');
  const issuer = escapeHtml(config.issuerName || '（填写我方公司名称）');
  const recipient = escapeHtml(config.recipientName || '（填写对方客户/收件人）');
  const footerNote = escapeHtml(
    config.footerNote || '本单据由 AnyToSheet 万物入表自动排版生成，请核对明细无误后确认。'
  );

  let bodyHtml = '';

  if (config.templateId === 'quotation' || config.templateId === 'statement') {
    const amountInfo = sumAmountColumn(headers, rows);
    const thead = `<tr><th>#</th>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    const tbody = rows
      .map(
        (r, idx) =>
          `<tr><td>${idx + 1}</td>${headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`
      )
      .join('');

    const signBlock =
      config.templateId === 'statement'
        ? `<div class="sign-grid">
             <div><strong>发出方（盖章）：</strong>${issuer}<br/><br/>经办人 / 日期：________________</div>
             <div><strong>确认方（盖章）：</strong>${recipient}<br/><br/>核对签字 / 日期：________________</div>
           </div>`
        : `<div class="sign-grid">
             <div><strong>报价方（盖章）：</strong>${issuer}<br/><br/>有效期：自报价日起 15 日内有效</div>
             <div><strong>客户确认签字：</strong>${recipient}<br/><br/>日期：________________</div>
           </div>`;

    bodyHtml = `
      <div class="page">
        <div class="doc-head">
          <h1 class="doc-title">${title}</h1>
          <div class="doc-meta">单号：${docNo}<br/>日期：${todayStr}</div>
        </div>
        <div class="party-grid">
          <div><strong>出具方：</strong>${issuer}</div>
          <div><strong>接收方：</strong>${recipient}</div>
        </div>
        <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        ${
          amountInfo
            ? `<div class="total-bar">${escapeHtml(amountInfo.colName)}总计：¥ ${amountInfo.total.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>`
            : ''
        }
        ${signBlock}
        <div class="footer-note">备注：${footerNote}</div>
      </div>
    `;
  } else if (config.templateId === 'per_row_card') {
    bodyHtml = rows
      .map((r, idx) => {
        const kvHtml = headers
          .map(
            (h) =>
              `<div class="kv-item"><div class="kv-label">${escapeHtml(h)}</div><div class="kv-val">${escapeHtml(r[h] || '-')}</div></div>`
          )
          .join('');
        return `
          <div class="page page-break">
            <div class="doc-head">
              <h1 class="doc-title">${title}</h1>
              <div class="doc-meta">编号：${docNo}-${idx + 1}<br/>日期：${todayStr}</div>
            </div>
            <div class="party-grid">
              <div><strong>出具单位：</strong>${issuer}</div>
              <div><strong>接收对象：</strong>${recipient}</div>
            </div>
            <div class="kv-grid">${kvHtml}</div>
            <div class="sign-grid">
              <div><strong>出具单位（盖章）：</strong>${issuer}</div>
              <div><strong>日期：</strong>${todayStr}</div>
            </div>
            <div class="footer-note">备注：${footerNote}</div>
          </div>
        `;
      })
      .join('');
  } else {
    const tpl =
      config.customBodyTemplate?.trim() ||
      headers.map((h) => `${h}：{{${h}}}`).join('\n');
    bodyHtml = rows
      .map(
        (r, idx) => `
        <div class="page page-break">
          <div class="doc-head">
            <h1 class="doc-title">${title}</h1>
            <div class="doc-meta">编号：${docNo}-${idx + 1}<br/>日期：${todayStr}</div>
          </div>
          <div class="custom-body">${interpolateTemplate(tpl, r)}</div>
          <div class="sign-grid">
            <div><strong>出具方：</strong>${issuer}</div>
            <div><strong>日期：</strong>${todayStr}</div>
          </div>
          <div class="footer-note">${footerNote}</div>
        </div>
      `
      )
      .join('');
  }

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <style>${PRINT_STYLES}</style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}

import { parseNumberValue } from './validator.js';

export type DocTemplateId = 'quotation' | 'statement' | 'per_row_card' | 'custom';

export interface DocGenConfig {
  templateId: DocTemplateId;
  docTitle: string;
  issuerName: string;
  recipientName: string;
  /** Optional column name to bind per-row recipient (e.g. 候选人姓名 / 客户名称) */
  recipientFieldCol?: string;
  /** Optional column name to split summary docs into separate per-group statements (e.g. 供应商名称) */
  groupByCol?: string;
  /** Subset of columns to display (hides internal cost/margin columns when sending externally) */
  visibleHeaders?: string[];
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
    description: '将选中记录汇总成带明细表、金额总计、人民币大写与盖章区的 A4 报价单（支持按供应商/客户自动拆单）',
  },
  {
    id: 'statement',
    name: '对账单（汇总明细）',
    mode: 'summary',
    defaultTitle: '月度业务对账单',
    description: '生成带总计、大写金额和双方签字确认栏的正式对账单（支持按往来单位自动拆单）',
  },
  {
    id: 'per_row_card',
    name: '一客一单 / Offer / 通知书（每行一页）',
    mode: 'perRow',
    defaultTitle: '正式通知单',
    description: '每行独立一页 A4 卡片，支持接收方自动绑定姓名列，适合批量发 Offer 或客户凭证',
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

function formatLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function toRmbUppercase(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  const negative = amount < 0;
  const n = Math.abs(Math.round(amount * 100));
  if (n === 0) return '零元整';

  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const units = ['', '拾', '佰', '仟'];
  const bigUnits = ['', '万', '亿'];

  const intPart = Math.floor(n / 100);
  const jiao = Math.floor((n % 100) / 10);
  const fen = n % 10;

  let intStr = '';
  let remaining = intPart;
  let unitIdx = 0;

  while (remaining > 0) {
    const section = remaining % 10000;
    if (section > 0) {
      let secStr = '';
      let zeroFlag = false;
      for (let i = 0; i < 4; i++) {
        const d = Math.floor(section / Math.pow(10, i)) % 10;
        if (d === 0) {
          if (secStr && !zeroFlag) {
            secStr = '零' + secStr;
            zeroFlag = true;
          }
        } else {
          secStr = digits[d] + units[i] + secStr;
          zeroFlag = false;
        }
      }
      intStr = secStr + bigUnits[unitIdx] + intStr;
    } else if (intStr && !intStr.startsWith('零')) {
      intStr = '零' + intStr;
    }
    remaining = Math.floor(remaining / 10000);
    unitIdx++;
  }

  let res = (negative ? '负' : '') + (intStr ? `${intStr}元` : '');
  if (jiao === 0 && fen === 0) {
    res += '整';
  } else {
    if (jiao > 0) res += `${digits[jiao]}角`;
    else if (intStr) res += '零';
    if (fen > 0) res += `${digits[fen]}分`;
  }
  return res;
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

/**
 * Word/WPS & A4 print-friendly styles using table-based layouts (no CSS Grid/Flex in body blocks)
 * so both Chrome PDF print and Microsoft Word / WPS .doc open with pixel-accurate alignment.
 */
const PRINT_STYLES = `
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 18px;
    font-family: "PingFang SC", "Microsoft YaHei", "SimHei", Arial, sans-serif;
    color: #1f2329;
    font-size: 13px;
    line-height: 1.6;
    background: #ffffff;
  }
  .page {
    width: 740px;
    margin: 0 auto 24px;
    padding: 28px 32px;
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    background: #fff;
  }
  .page-break { page-break-after: always; }
  .page-break:last-child { page-break-after: auto; }
  table.layout-tbl { width: 100%; border-collapse: collapse; border: none; margin: 0; }
  table.layout-tbl td { border: none; padding: 0; vertical-align: top; }
  .head-wrap { border-bottom: 2px solid #1f2329; padding-bottom: 12px; margin-bottom: 16px; }
  .doc-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: 1px; }
  .doc-meta { font-size: 12px; color: #646a73; text-align: right; white-space: nowrap; }
  .party-box {
    background: #f7f8fa;
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 12px;
  }
  table.data-tbl { width: 100%; border-collapse: collapse; margin: 10px 0 16px; font-size: 12px; }
  table.data-tbl th, table.data-tbl td { border: 1px solid #d9dce3; padding: 7px 9px; text-align: left; }
  table.data-tbl th { background: #f2f3f5; font-weight: 600; white-space: nowrap; }
  .total-bar {
    text-align: right;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 14px;
    background: #f0f5ff;
    border-radius: 6px;
    color: #1d4ed8;
    margin-bottom: 18px;
  }
  .total-cn { font-size: 12px; font-weight: 400; color: #4e5969; margin-top: 2px; }
  table.kv-tbl { width: 100%; border-collapse: separate; border-spacing: 8px; margin: 8px -8px 18px; }
  table.kv-tbl td { width: 50%; border: 1px solid #e5e6eb; border-radius: 6px; padding: 8px 12px; vertical-align: top; }
  .kv-label { font-size: 11px; color: #646a73; }
  .kv-val { font-size: 14px; font-weight: 600; margin-top: 2px; word-break: break-word; }
  .custom-body {
    white-space: pre-wrap;
    font-size: 14px;
    line-height: 1.85;
    padding: 12px 0 20px;
  }
  .sign-wrap {
    margin-top: 26px;
    padding-top: 14px;
    border-top: 1px dashed #c9cdd4;
    font-size: 12px;
    color: #4e5969;
  }
  .footer-note { margin-top: 14px; font-size: 11px; color: #86909c; }
  @media print {
    body { padding: 0; }
    .page { border: none; padding: 0; margin: 0; width: 100%; }
  }
`;

function renderSummaryPage(
  headers: string[],
  rows: Array<Record<string, string>>,
  opts: {
    templateId: 'quotation' | 'statement';
    title: string;
    docNo: string;
    todayStr: string;
    issuer: string;
    recipient: string;
    footerNote: string;
  }
): string {
  const amountInfo = sumAmountColumn(headers, rows);
  const thead = `<tr><th style="width:36px;text-align:center;">#</th>${headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('')}</tr>`;
  const tbody = rows
    .map(
      (r, idx) =>
        `<tr><td style="text-align:center;">${idx + 1}</td>${headers
          .map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`)
          .join('')}</tr>`
    )
    .join('');

  const signRow =
    opts.templateId === 'statement'
      ? `<tr>
           <td style="width:50%;padding-right:16px;"><strong>发出方（盖章）：</strong>${opts.issuer}<br/><br/>经办人 / 日期：________________</td>
           <td style="width:50%;"><strong>确认方（盖章）：</strong>${opts.recipient}<br/><br/>核对签字 / 日期：________________</td>
         </tr>`
      : `<tr>
           <td style="width:50%;padding-right:16px;"><strong>报价方（盖章）：</strong>${opts.issuer}<br/><br/>有效期：自报价日起 15 日内有效</td>
           <td style="width:50%;"><strong>客户确认签字：</strong>${opts.recipient}<br/><br/>日期：________________</td>
         </tr>`;

  return `
    <div class="page page-break">
      <div class="head-wrap">
        <table class="layout-tbl">
          <tr>
            <td><h1 class="doc-title">${opts.title}</h1></td>
            <td class="doc-meta">单号：${opts.docNo}<br/>日期：${opts.todayStr}</td>
          </tr>
        </table>
      </div>
      <div class="party-box">
        <table class="layout-tbl">
          <tr>
            <td style="width:50%;padding-right:12px;"><strong>出具方：</strong>${opts.issuer}</td>
            <td style="width:50%;"><strong>接收方：</strong>${opts.recipient}</td>
          </tr>
        </table>
      </div>
      <table class="data-tbl"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      ${
        amountInfo
          ? `<div class="total-bar">
               <div>${escapeHtml(amountInfo.colName)}总计：¥ ${amountInfo.total.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
               <div class="total-cn">人民币大写：${escapeHtml(toRmbUppercase(amountInfo.total))}</div>
             </div>`
          : ''
      }
      <div class="sign-wrap"><table class="layout-tbl">${signRow}</table></div>
      <div class="footer-note">备注：${opts.footerNote}</div>
    </div>
  `;
}

export function renderDeliverableHtml(
  allHeaders: string[],
  rows: Array<Record<string, string>>,
  config: DocGenConfig
): string {
  const headers =
    config.visibleHeaders && config.visibleHeaders.length > 0
      ? allHeaders.filter((h) => config.visibleHeaders!.includes(h))
      : allHeaders;

  const todayStr = formatLocalDate();
  const baseDocNo = `ATS-${todayStr.replace(/-/g, '')}`;
  const title = escapeHtml(config.docTitle || '业务单据');
  const issuer = escapeHtml(config.issuerName || '（填写我方公司名称）');
  const defaultRecipient = escapeHtml(config.recipientName || '（未指定接收方）');
  const footerNote = escapeHtml(
    config.footerNote || '本单据由 AnyToSheet 万物入表自动排版生成，请核对明细无误后确认。'
  );

  let bodyHtml = '';

  if (config.templateId === 'quotation' || config.templateId === 'statement') {
    if (config.groupByCol && allHeaders.includes(config.groupByCol)) {
      const groups = new Map<string, Array<Record<string, string>>>();
      for (const r of rows) {
        const key = (r[config.groupByCol] || '未分组').trim();
        const list = groups.get(key) || [];
        list.push(r);
        groups.set(key, list);
      }
      let gIdx = 0;
      for (const [groupName, groupRows] of groups.entries()) {
        gIdx++;
        bodyHtml += renderSummaryPage(headers, groupRows, {
          templateId: config.templateId,
          title,
          docNo: `${baseDocNo}-${String(gIdx).padStart(2, '0')}`,
          todayStr,
          issuer,
          recipient: escapeHtml(config.recipientName || groupName),
          footerNote,
        });
      }
    } else {
      bodyHtml = renderSummaryPage(headers, rows, {
        templateId: config.templateId,
        title,
        docNo: `${baseDocNo}-${String(rows.length).padStart(2, '0')}`,
        todayStr,
        issuer,
        recipient: defaultRecipient,
        footerNote,
      });
    }
  } else if (config.templateId === 'per_row_card') {
    bodyHtml = rows
      .map((r, idx) => {
        const rowRecipient =
          config.recipientFieldCol && r[config.recipientFieldCol]
            ? escapeHtml(r[config.recipientFieldCol])
            : defaultRecipient;

        const kvRows: string[] = [];
        for (let i = 0; i < headers.length; i += 2) {
          const h1 = headers[i];
          const h2 = headers[i + 1];
          kvRows.push(
            `<tr>
              <td><div class="kv-label">${escapeHtml(h1)}</div><div class="kv-val">${escapeHtml(r[h1] || '-')}</div></td>
              ${
                h2
                  ? `<td><div class="kv-label">${escapeHtml(h2)}</div><div class="kv-val">${escapeHtml(r[h2] || '-')}</div></td>`
                  : `<td style="border:none;"></td>`
              }
            </tr>`
          );
        }

        return `
          <div class="page page-break">
            <div class="head-wrap">
              <table class="layout-tbl">
                <tr>
                  <td><h1 class="doc-title">${title}</h1></td>
                  <td class="doc-meta">编号：${baseDocNo}-${idx + 1}<br/>日期：${todayStr}</td>
                </tr>
              </table>
            </div>
            <div class="party-box">
              <table class="layout-tbl">
                <tr>
                  <td style="width:50%;padding-right:12px;"><strong>出具单位：</strong>${issuer}</td>
                  <td style="width:50%;"><strong>接收对象：</strong>${rowRecipient}</td>
                </tr>
              </table>
            </div>
            <table class="kv-tbl">${kvRows.join('')}</table>
            <div class="sign-wrap">
              <table class="layout-tbl">
                <tr>
                  <td style="width:50%;"><strong>出具单位（盖章）：</strong>${issuer}</td>
                  <td style="width:50%;text-align:right;"><strong>日期：</strong>${todayStr}</td>
                </tr>
              </table>
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
      .map((r, idx) => {
        const rowRecipient =
          config.recipientFieldCol && r[config.recipientFieldCol]
            ? escapeHtml(r[config.recipientFieldCol])
            : config.recipientName
              ? escapeHtml(config.recipientName)
              : '';
        return `
          <div class="page page-break">
            <div class="head-wrap">
              <table class="layout-tbl">
                <tr>
                  <td><h1 class="doc-title">${title}</h1></td>
                  <td class="doc-meta">编号：${baseDocNo}-${idx + 1}<br/>日期：${todayStr}</td>
                </tr>
              </table>
            </div>
            ${
              rowRecipient
                ? `<div class="party-box"><strong>接收对象：</strong>${rowRecipient}</div>`
                : ''
            }
            <div class="custom-body">${interpolateTemplate(tpl, r)}</div>
            <div class="sign-wrap">
              <table class="layout-tbl">
                <tr>
                  <td style="width:50%;"><strong>出具方：</strong>${issuer}</td>
                  <td style="width:50%;text-align:right;"><strong>日期：</strong>${todayStr}</td>
                </tr>
              </table>
            </div>
            <div class="footer-note">${footerNote}</div>
          </div>
        `;
      })
      .join('');
  }

  return `<!doctype html>
<html lang="zh-CN" xmlns:w="urn:schemas-microsoft-com:office:word">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <style>${PRINT_STYLES}</style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}

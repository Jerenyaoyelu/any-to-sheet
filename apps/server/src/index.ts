import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {
  buildCleanRulePrompt,
  buildExtractionPrompt,
  sanitizeCleanRuleSteps,
  suggestReconcileMapping,
  validateExtractionItems,
  type CleanRulePlan,
  type ExtractionRawItem,
  type ExtractResponse,
  type TableSchema,
} from '@table-ai/core';
import { QuotaStore } from './quotaStore.js';
import { RuntimeConfigStore, assertPublicHttpsBaseUrl } from './runtimeConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
});

const ALLOWED_CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ALLOWED_CORS_ORIGINS.length > 0 ? ALLOWED_CORS_ORIGINS : true,
  })
);
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT || 3001);
const ENV_LLM_MODEL = process.env.LLM_MODEL?.trim() || 'qwen-vl-max-latest';
const ENV_LLM_API_KEY = process.env.LLM_API_KEY?.trim() || '';
const runtimeConfig = new RuntimeConfigStore(path.resolve(__dirname, '../data/runtime-config.json'), {
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  llmModel: ENV_LLM_MODEL,
  llmFreeModel: process.env.LLM_FREE_MODEL?.trim() || '',
  llmProModel: process.env.LLM_PRO_MODEL?.trim() || '',
  llmApiKey: ENV_LLM_API_KEY,
  freeWelcomePages: Number(process.env.FREE_WELCOME_PAGES ?? 8),
  freeDailyPages: Number(process.env.FREE_DAILY_PAGES ?? 2),
  globalDailyFreeLimit: Number(process.env.GLOBAL_DAILY_FREE_LIMIT ?? 1000),
  ipDailyFreeLimit: Number(process.env.IP_DAILY_FREE_LIMIT ?? 30),
  encryptionKey: process.env.CONFIG_ENCRYPTION_KEY?.trim() || '',
});
const bootConfig = runtimeConfig.getEffective();

const RAW_ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || '';
// Default dev token follows the environment key only, so saving a key in the admin console cannot lock the operator out.
const EFFECTIVE_ADMIN_TOKEN =
  RAW_ADMIN_TOKEN && RAW_ADMIN_TOKEN !== 'change-me-in-production'
    ? RAW_ADMIN_TOKEN
    : ENV_LLM_API_KEY
      ? ''
      : 'dev-admin-123';

const quotaStore = new QuotaStore(path.resolve(__dirname, '../data/quota-store.json'), {
  freeWelcomePages: bootConfig.freeWelcomePages,
  freeDailyPages: bootConfig.freeDailyPages,
  globalDailyFreeLimit: bootConfig.globalDailyFreeLimit,
  ipDailyFreeLimit: bootConfig.ipDailyFreeLimit,
  freeMaxFiles: 3,
  proMaxFiles: 20,
  freeMaxPdfPages: 3,
  proMaxPdfPages: 10,
  isMockMode: !bootConfig.apiKey,
});

function applyRuntimeQuotaPolicy(): void {
  const current = runtimeConfig.getEffective();
  quotaStore.updateRuntimePolicy({
    freeWelcomePages: current.freeWelcomePages,
    freeDailyPages: current.freeDailyPages,
    globalDailyFreeLimit: current.globalDailyFreeLimit,
    ipDailyFreeLimit: current.ipDailyFreeLimit,
    isMockMode: !current.apiKey,
  });
}

function getClientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function getUserHeaders(req: express.Request): { userId: string; tenantKey?: string } {
  const rawUid = req.headers['x-user-id'];
  const rawTenant = req.headers['x-tenant-key'];
  const userId =
    typeof rawUid === 'string' && rawUid.trim()
      ? rawUid.trim()
      : `ip_${getClientIp(req)}`;
  const tenantKey =
    typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : undefined;
  return { userId, tenantKey };
}

function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const ipCheck = quotaStore.checkIpRateLimit(getClientIp(req), 'admin', 60);
  if (!ipCheck.allowed) {
    res.status(429).json({ error: `管理请求过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
    return;
  }

  const rawToken = req.headers['x-admin-token'];
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!EFFECTIVE_ADMIN_TOKEN || !safeTokenEquals(token, EFFECTIVE_ADMIN_TOKEN)) {
    res.status(401).json({ error: '管理员密钥无效或未配置 ADMIN_TOKEN' });
    return;
  }
  next();
}

function decodeFileName(name: string): string {
  if (!/^[\u0000-\u00ff]*$/.test(name)) {
    return name;
  }
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

/** First complete JSON object/array, ignoring braces that sit inside strings. */
function sliceFirstJsonValue(text: string, start: number): string | null {
  const opener = text[start];
  if (opener !== '{' && opener !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * Models often append a second object or a note after a valid JSON value.
 * Taking the first `{` through the last `}` makes JSON.parse throw
 * "Unexpected non-whitespace character after JSON".
 */
function parseModelItems(raw: string): { items: ExtractionRawItem[] } {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const relative = text.slice(searchFrom).search(/[[{]/);
    if (relative === -1) break;
    const start = searchFrom + relative;
    const slice = sliceFirstJsonValue(text, start);
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(slice) as { items?: unknown };
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        return { items: parsed.items as ExtractionRawItem[] };
      }
    } catch {
      // This brace pair was not the payload. Keep scanning.
    }
    searchFrom = start + 1;
  }
  throw new Error('大模型返回的内容无法解析成提取结果，请重试一次');
}

function parseFirstJsonObject<T>(raw: string): T | null {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf('{', searchFrom);
    if (idx === -1) break;
    const slice = sliceFirstJsonValue(text, idx);
    if (!slice) {
      searchFrom = idx + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(slice) as T;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Keep scanning for a valid JSON object
    }
    searchFrom = idx + 1;
  }
  return null;
}

function parseAndValidateSchema(raw: unknown): TableSchema | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TableSchema>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.fields) ||
      typeof parsed.tableName !== 'string'
    ) {
      return null;
    }
    return {
      tableId: typeof parsed.tableId === 'string' ? parsed.tableId : 'unknown',
      tableName: parsed.tableName,
      fields: parsed.fields,
      attachmentFields: Array.isArray(parsed.attachmentFields) ? parsed.attachmentFields : undefined,
      sampleRows: Array.isArray(parsed.sampleRows) ? parsed.sampleRows : [],
    };
  } catch {
    return null;
  }
}

/**
 * CNY per 1M tokens, input window ≤32K. Unknown models use Doubao-Seed-2.0-lite list price.
 * mini 0.20/2.00, lite 0.60/3.60, pro 3.20/16, Qwen3-VL-Plus 1/10.
 */
function estimateModelCostCny(modelName: string, promptTokens: number, completionTokens: number): number {
  const name = modelName.toLowerCase();
  let inputPerMillion = 0.6;
  let outputPerMillion = 3.6;
  if (name.includes('mini')) {
    inputPerMillion = 0.2;
    outputPerMillion = 2;
  } else if (name.includes('doubao') && name.includes('pro')) {
    inputPerMillion = 3.2;
    outputPerMillion = 16;
  } else if (name.includes('qwen')) {
    inputPerMillion = 1;
    outputPerMillion = 10;
  }
  const cost = (promptTokens * inputPerMillion + completionTokens * outputPerMillion) / 1_000_000;
  return Number(cost.toFixed(4));
}

function generateMockItems(schema: TableSchema, fileNames: string[]): ExtractionRawItem[] {
  const writableFields = schema.fields.filter((f) => !f.readonly && f.type !== 'unknown');
  const results: ExtractionRawItem[] = [];

  fileNames.forEach((fileName, fileIndex) => {
    const rowCount = fileIndex === 0 ? 2 : 1;
    const baseName = fileName.replace(/\.[^.]+$/, '');
    for (let i = 0; i < rowCount; i++) {
      const values: Record<string, unknown> = {};
      const confidence: Record<string, number> = {};

      for (const field of writableFields) {
        const name = field.name;
        if (field.type === 'number') {
          if (/数量|件数|qty/i.test(name)) {
            values[name] = i === 0 ? 10 : 5;
            confidence[name] = 0.96;
          } else if (/单价|unit\s*price/i.test(name)) {
            values[name] = i === 0 ? 128.5 : 240;
            confidence[name] = 0.94;
          } else if (/总价|金额|合计|total|amount/i.test(name)) {
            values[name] = i === 0 ? 1285 : 1250;
            confidence[name] = i === 0 ? 0.97 : 0.72;
          } else if (/年限|经验|岁|年龄/i.test(name)) {
            values[name] = 4 + i;
            confidence[name] = 0.92;
          } else {
            values[name] = (i + 1) * 100;
            confidence[name] = 0.9;
          }
        } else if (field.type === 'date') {
          values[name] = i === 0 ? '2026-11-20' : '2026/11/25';
          confidence[name] = 0.95;
        } else if (field.type === 'singleSelect') {
          const opt = field.options?.[i % (field.options.length || 1)]?.name ?? '待确认';
          values[name] = opt;
          confidence[name] = i === 0 ? 0.93 : 0.74;
        } else if (field.type === 'multiSelect') {
          const opts = field.options?.slice(0, 2).map((o) => o.name) ?? ['标签A'];
          values[name] = opts;
          confidence[name] = 0.9;
        } else if (field.type === 'checkbox') {
          values[name] = i === 0;
          confidence[name] = 0.95;
        } else if (/手机|电话|phone/i.test(name)) {
          values[name] = `1380013800${fileIndex}${i}`;
          confidence[name] = 0.98;
        } else if (/邮箱|email/i.test(name)) {
          values[name] = `contact_${fileIndex}_${i}@example.com`;
          confidence[name] = 0.97;
        } else if (/供应商|商户|公司|收款方/i.test(name)) {
          values[name] = i === 0 ? '杭州星辰包装有限公司' : '星辰包装（待核对简称）';
          confidence[name] = i === 0 ? 0.95 : 0.74;
        } else if (/商品|产品|品名|项目/i.test(name)) {
          values[name] = i === 0 ? '定制礼盒外箱 30*20cm' : '加厚防震气泡袋 M号';
          confidence[name] = 0.94;
        } else if (/姓名|候选人/i.test(name)) {
          values[name] = i === 0 ? '林晓明' : '陈思远';
          confidence[name] = 0.96;
        } else {
          values[name] = `${baseName} - 示例项${i + 1}`;
          confidence[name] = i === 0 ? 0.95 : 0.76;
        }
      }

      results.push({
        sourceFileName: fileName,
        values,
        confidence,
      });
    }
  });

  return results;
}

function formatFriendlyLlmError(status: number, errText: string, modelName: string): string {
  console.error(`[llm-upstream-error] status=${status} model=${modelName} body=${errText.slice(0, 400)}`);
  if (status === 404 || /InvalidEndpointOrModel|NotFound/i.test(errText)) {
    return `模型「${modelName}」不可用或未在模型平台开通，请管理员在后台 /admin 或 .env 中核对模型 ID / 接入点配置。`;
  }
  if (status === 401 || status === 403) {
    return '模型 API Key 无效或无调用权限，请管理员检查密钥配置。';
  }
  if (status === 429) {
    return '上游大模型请求过于频繁或账号额度已满，请稍后再试。';
  }
  if (status >= 500) {
    return `上游大模型服务暂时异常 (${status})，请稍后重试（本次未扣额度）。`;
  }
  return `大模型调用失败 (${status})，请稍后重试或联系管理员检查配置（本次未扣额度）。`;
}

async function callMultimodalLLM(
  modelName: string,
  schema: TableSchema,
  files: Express.Multer.File[],
  userHint?: string
): Promise<{
  items: ExtractionRawItem[];
  promptTokens?: number;
  completionTokens?: number;
}> {
  const llm = runtimeConfig.getEffective();
  if (!llm.apiKey) {
    throw new Error('未配置模型密钥');
  }
  const baseUrl = await assertPublicHttpsBaseUrl(llm.baseUrl);
  const fileNames = files.map((f) => decodeFileName(f.originalname));
  const { systemPrompt, userPrompt } = buildExtractionPrompt(schema, fileNames, userHint);

  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userPrompt }];

  for (const file of files) {
    const cleanName = decodeFileName(file.originalname);
    if (file.mimetype.startsWith('image/')) {
      const b64 = file.buffer.toString('base64');
      userContent.push({
        type: 'text',
        text: `【文件：${cleanName}】`,
      });
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${file.mimetype};base64,${b64}`,
        },
      });
    } else if (
      file.mimetype.startsWith('text/') ||
      /\.(txt|md|csv|json|xml|html)$/i.test(cleanName)
    ) {
      const textBody = file.buffer.toString('utf8').slice(0, 15000);
      userContent.push({
        type: 'text',
        text: `【文本文件：${cleanName}】\n${textBody}`,
      });
    } else {
      const readableText = file.buffer
        .toString('utf8')
        .replace(/[^\x20-\x7E\u4e00-\u9fa5\n\r\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12000);
      userContent.push({
        type: 'text',
        text: `【文档文件：${cleanName} (${file.mimetype})】\n${readableText || '（二进制文件，建议前端转图片后识别）'}`,
      });
    }
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('模型服务返回了重定向，已拒绝跟随');
  }
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(formatFriendlyLlmError(response.status, errText, modelName));
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('大模型未返回有效内容');
  }

  const parsed = parseModelItems(rawContent);

  return {
    items: parsed.items,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}

const ALLOWED_ATTACHMENT_HOST_SUFFIXES = [
  '.feishu.cn',
  '.larksuite.com',
  '.larkoffice.com',
  '.feishucdn.com',
  '.byteimg.com',
  '.bytedance.com',
];

function isAllowedAttachmentUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.port && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_ATTACHMENT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

async function fetchAttachmentSafely(initialUrl: string, maxBytes: number): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  let currentUrl = initialUrl;
  let upstream: Response | null = null;

  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedAttachmentUrl(currentUrl)) {
      throw new Error('目标附件重定向地址不在飞书安全白名单内');
    }
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`附件重定向缺少 Location (${res.status})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    upstream = res;
    break;
  }

  if (!upstream) {
    throw new Error('附件重定向次数过多');
  }
  if (!upstream.ok) {
    throw new Error(`拉取飞书附件失败 (${upstream.status})`);
  }

  const contentLength = Number(upstream.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new Error('单个附件超过 20MB 限制');
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    throw new Error('无法读取附件响应流');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error('单个附件超过 20MB 限制');
    }
    chunks.push(value);
  }

  return {
    buffer: Buffer.concat(chunks, totalBytes),
    contentType: upstream.headers.get('content-type') || 'application/octet-stream',
  };
}

// ========== Lightweight Admin Dashboard UI ==========
app.get('/admin', (_req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(path.resolve(__dirname, '../public/admin.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: runtimeConfig.getEffective().apiKey ? 'llm' : 'mock',
    freeModel: runtimeConfig.getEffective().apiKey ? runtimeConfig.getEffective().freeModel : 'mock-demo',
    proModel: runtimeConfig.getEffective().apiKey ? runtimeConfig.getEffective().proModel : 'mock-demo',
  });
});

app.get('/api/quota', (req, res) => {
  const ipCheck = quotaStore.checkIpRateLimit(getClientIp(req), 'quota', 30);
  if (!ipCheck.allowed) {
    res.status(429).json({ error: `查询过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
    return;
  }

  const { userId, tenantKey } = getUserHeaders(req);
  const snapshot = quotaStore.getSnapshot(userId, tenantKey);
  res.json({
    mode: runtimeConfig.getEffective().apiKey ? 'llm' : 'mock',
    quota: snapshot,
  });
});

app.post('/api/quota/redeem', (req, res) => {
  const ipCheck = quotaStore.checkIpRateLimit(getClientIp(req), 'redeem', 8);
  if (!ipCheck.allowed) {
    res.status(429).json({ error: `操作过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
    return;
  }

  const { userId, tenantKey } = getUserHeaders(req);
  const result = quotaStore.redeemCode(userId, req.body?.code, tenantKey);

  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    ok: true,
    addedPages: result.addedPages,
    quota: result.snapshot,
  });
});

// ========== Admin APIs (Protected by x-admin-token) ==========
app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    mode: runtimeConfig.getEffective().apiKey ? 'llm' : 'mock',
    overview: quotaStore.getAdminOverview(),
  });
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({ ok: true, users: quotaStore.listUsers() });
});

app.post('/api/admin/users/:userId/grant', requireAdmin, (req, res) => {
  try {
    const deltaPages = Number(req.body?.deltaPages);
    if (!Number.isFinite(deltaPages) || deltaPages === 0) {
      res.status(400).json({ error: 'deltaPages 必须为非零数字（正数赠送，负数扣减）' });
      return;
    }
    const quota = quotaStore.adjustUserPaidPages(String(req.params.userId), deltaPages);
    res.json({ ok: true, quota });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '调整失败' });
  }
});

app.get('/api/admin/codes', requireAdmin, (_req, res) => {
  res.json({ ok: true, codes: quotaStore.listCodes() });
});

app.post('/api/admin/codes/generate', requireAdmin, (req, res) => {
  const count = Number(req.body?.count ?? 10);
  const pages = Number(req.body?.pages ?? 100);
  const priceCny = Number(req.body?.priceCny ?? 0);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(pages) || pages < 1) {
    res.status(400).json({ error: 'count 和 pages 必须为大于 0 的数字' });
    return;
  }
  if (!Number.isFinite(priceCny) || priceCny < 0) {
    res.status(400).json({ error: 'priceCny 必须为大于等于 0 的数字' });
    return;
  }

  const created = quotaStore.generateCodes(count, pages, {
    priceCny,
    channel: req.body?.channel,
    note: req.body?.note,
  });
  res.json({ ok: true, count: created.length, codes: created });
});

app.post('/api/admin/codes/:code/revoke', requireAdmin, (req, res) => {
  const result = quotaStore.revokeCode(String(req.params.code));
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, record: result.record });
});

app.get('/api/admin/logs', requireAdmin, (_req, res) => {
  res.json({ ok: true, logs: quotaStore.listLogs() });
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, settings: runtimeConfig.getPublicSettings() });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const settings = await runtimeConfig.update({
      llmBaseUrl: String(body.llmBaseUrl ?? ''),
      llmModel: String(body.llmModel ?? ''),
      llmFreeModel: String(body.llmFreeModel ?? ''),
      llmProModel: String(body.llmProModel ?? ''),
      freeWelcomePages: Number(body.freeWelcomePages),
      freeDailyPages: Number(body.freeDailyPages),
      globalDailyFreeLimit: Number(body.globalDailyFreeLimit),
      ipDailyFreeLimit: Number(body.ipDailyFreeLimit),
      llmApiKey: typeof body.llmApiKey === 'string' ? body.llmApiKey : undefined,
      clearApiKey: body.clearApiKey === true,
    });
    applyRuntimeQuotaPolicy();
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '保存配置失败' });
  }
});

app.post('/api/fetch-attachment', async (req, res) => {
  const ipCheck = quotaStore.checkIpRateLimit(getClientIp(req), 'fetch_att', 20);
  if (!ipCheck.allowed) {
    res.status(429).json({ error: `拉取过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
    return;
  }

  try {
    const url = req.body?.url;
    if (typeof url !== 'string' || !isAllowedAttachmentUrl(url)) {
      res.status(400).json({ error: '仅允许代理合法的飞书附件 HTTPS 地址' });
      return;
    }

    const { buffer, contentType } = await fetchAttachmentSafely(url, 20 * 1024 * 1024);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    res.send(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : '附件拉取失败';
    const status = message.includes('白名单') ? 400 : message.includes('20MB') ? 413 : 502;
    res.status(status).json({ error: message });
  }
});

app.post('/api/extract', upload.array('files', 25), async (req, res) => {
  let reservationId: string | null = null;
  let reservedUserId = '';
  let reservedTier: 'free' | 'pro' = 'free';
  let chosenModel = runtimeConfig.getEffective().freeModel;
  let pageCost = 0;

  try {
    const clientIp = getClientIp(req);
    const ipCheck = quotaStore.checkIpRateLimit(clientIp, 'extract', 10);
    if (!ipCheck.allowed) {
      res.status(429).json({ error: `请求过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
      return;
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: '请至少上传一个文件（图片/截图/文本/PDF）' });
      return;
    }

    const schema = parseAndValidateSchema(req.body?.schema);
    if (!schema) {
      res.status(400).json({ error: '目标表格 Schema 格式无效或缺少 fields 字段' });
      return;
    }

    const { userId, tenantKey } = getUserHeaders(req);
    pageCost = files.length;

    const reserveRes = quotaStore.reserve(userId, pageCost, tenantKey, clientIp);
    if (!reserveRes.allowed) {
      res.status(reserveRes.statusCode).json({
        error: reserveRes.error,
        quota: reserveRes.snapshot,
      });
      return;
    }

    reservationId = reserveRes.reservation.id;
    reservedUserId = reserveRes.reservation.userId;
    reservedTier = reserveRes.reservation.plan.useProModel ? 'pro' : 'free';
    const llm = runtimeConfig.getEffective();
    chosenModel = reserveRes.reservation.plan.useProModel ? llm.proModel : llm.freeModel;

    const userHint = typeof req.body?.userHint === 'string' ? req.body.userHint : undefined;
    const fileNames = files.map((f) => decodeFileName(f.originalname));

    let items: ExtractionRawItem[];
    let mode: 'llm' | 'mock' = 'mock';
    let promptTokens = 0;
    let completionTokens = 0;

    if (llm.apiKey) {
      mode = 'llm';
      const llmRes = await callMultimodalLLM(chosenModel, schema, files, userHint);
      items = llmRes.items;
      promptTokens = llmRes.promptTokens ?? 0;
      completionTokens = llmRes.completionTokens ?? 0;
    } else {
      items = generateMockItems(schema, fileNames);
    }

    const validatedRows = validateExtractionItems(schema, items);

    const updatedQuota = quotaStore.commit(reservationId);
    reservationId = null;

    const estimatedCostCny =
      mode === 'llm' ? estimateModelCostCny(chosenModel, promptTokens, completionTokens) : 0;

    quotaStore.recordLog({
      userId: reservedUserId,
      tier: reservedTier,
      mode,
      model: mode === 'llm' ? chosenModel : 'mock-demo',
      pages: pageCost,
      rowsExtracted: validatedRows.length,
      estimatedCostCny,
      status: 'ok',
    });

    const payload: ExtractResponse = {
      mode,
      model: mode === 'llm' ? chosenModel : 'mock-demo（未配置模型密钥）',
      rows: validatedRows,
      estimatedCostCny,
      consumedPages: pageCost,
      quota: updatedQuota,
      usage: mode === 'llm' ? { promptTokens, completionTokens } : undefined,
    };

    res.json(payload);
  } catch (err) {
    if (reservationId) {
      quotaStore.release(reservationId);
      quotaStore.recordLog({
        userId: reservedUserId || 'unknown',
        tier: reservedTier,
        mode: runtimeConfig.getEffective().apiKey ? 'llm' : 'mock',
        model: runtimeConfig.getEffective().apiKey ? chosenModel : 'mock-demo',
        pages: pageCost,
        rowsExtracted: 0,
        estimatedCostCny: 0,
        status: 'error',
        error: err instanceof Error ? err.message.slice(0, 180) : '未知提取错误',
      });
    }
    const message = err instanceof Error ? err.message : '未知提取错误';
    console.error('[extract error]', err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/clean-rules', async (req, res) => {
  let reservationId: string | null = null;
  let reservedUserId = '';
  let reservedTier: 'free' | 'pro' = 'free';
  let chosenModel = runtimeConfig.getEffective().freeModel;

  try {
    const clientIp = getClientIp(req);
    const ipCheck = quotaStore.checkIpRateLimit(clientIp, 'clean_rules', 12);
    if (!ipCheck.allowed) {
      res.status(429).json({ error: `请求过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
      return;
    }

    const fieldName = typeof req.body?.fieldName === 'string' ? req.body.fieldName.trim().slice(0, 80) : '';
    const fieldType = typeof req.body?.fieldType === 'string' ? req.body.fieldType.trim().slice(0, 32) : 'text';
    const instruction =
      typeof req.body?.instruction === 'string' ? req.body.instruction.trim().slice(0, 500) : '';
    const samples: string[] = Array.isArray(req.body?.samples)
      ? req.body.samples
          .map((x: unknown) => String(x ?? '').slice(0, 300))
          .filter(Boolean)
          .slice(0, 20)
      : [];

    if (!fieldName || !instruction) {
      res.status(400).json({ error: '请提供目标列名和清洗要求' });
      return;
    }

    const { userId, tenantKey } = getUserHeaders(req);
    const reserveRes = quotaStore.reserve(userId, 1, tenantKey, clientIp);
    if (!reserveRes.allowed) {
      res.status(reserveRes.statusCode).json({
        error: reserveRes.error,
        quota: reserveRes.snapshot,
      });
      return;
    }

    reservationId = reserveRes.reservation.id;
    reservedUserId = reserveRes.reservation.userId;
    reservedTier = reserveRes.reservation.plan.useProModel ? 'pro' : 'free';

    const llm = runtimeConfig.getEffective();
    chosenModel = reserveRes.reservation.plan.useProModel ? llm.proModel : llm.freeModel;

    let plan: CleanRulePlan;
    let mode: 'llm' | 'mock' = 'mock';
    let promptTokens = 0;
    let completionTokens = 0;

    if (llm.apiKey) {
      mode = 'llm';
      const baseUrl = await assertPublicHttpsBaseUrl(llm.baseUrl);
      const { systemPrompt, userPrompt } = buildCleanRulePrompt(
        fieldName,
        fieldType,
        samples,
        instruction
      );

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(45000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: chosenModel,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(formatFriendlyLlmError(response.status, errText, chosenModel));
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) throw new Error('大模型未返回有效清洗规则，本次未扣额度');

      const parsed = parseFirstJsonObject<Partial<CleanRulePlan>>(rawContent);
      const safeSteps = sanitizeCleanRuleSteps(parsed?.steps);
      if (safeSteps.length === 0) {
        throw new Error('未能解析出安全有效的清洗步骤，请换个更具体的描述重试（本次未扣额度）');
      }
      plan = {
        summary:
          typeof parsed?.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim().slice(0, 160)
            : instruction,
        steps: safeSteps,
      };
      promptTokens = data.usage?.prompt_tokens ?? 0;
      completionTokens = data.usage?.completion_tokens ?? 0;
    } else {
      const steps: CleanRulePlan['steps'] = [{ op: 'stripInvisible' }, { op: 'toHalfWidth' }, { op: 'trim' }];
      if (/日期|date/i.test(instruction)) steps.push({ op: 'normalizeDate' });
      else if (/手机|电话|phone/i.test(instruction)) steps.push({ op: 'extractPhone' });
      else if (/数字|金额|单价/i.test(instruction)) steps.push({ op: 'extractNumber' });
      else if (/括号|备注/i.test(instruction)) steps.push({ op: 'removeBrackets' }, { op: 'trim' });
      else if (/大写/i.test(instruction)) steps.push({ op: 'case', mode: 'upper' });
      else if (/小写/i.test(instruction)) steps.push({ op: 'case', mode: 'lower' });
      else steps.push({ op: 'normalizeWhitespace' });

      plan = {
        summary: `演示模式规则：${instruction}`,
        steps,
      };
    }

    const updatedQuota = quotaStore.commit(reservationId);
    reservationId = null;

    const estimatedCostCny =
      mode === 'llm' ? estimateModelCostCny(chosenModel, promptTokens, completionTokens) : 0;

    quotaStore.recordLog({
      userId: reservedUserId,
      tier: reservedTier,
      mode,
      model: mode === 'llm' ? chosenModel : 'mock-demo',
      pages: 1,
      rowsExtracted: plan.steps.length,
      estimatedCostCny,
      status: 'ok',
    });

    res.json({
      ok: true,
      mode,
      model: mode === 'llm' ? chosenModel : 'mock-demo',
      plan,
      estimatedCostCny,
      quota: updatedQuota,
    });
  } catch (err) {
    if (reservationId) {
      quotaStore.release(reservationId);
      quotaStore.recordLog({
        userId: reservedUserId || 'unknown',
        tier: reservedTier,
        mode: runtimeConfig.getEffective().apiKey ? 'llm' : 'mock',
        model: runtimeConfig.getEffective().apiKey ? chosenModel : 'mock-demo',
        pages: 1,
        rowsExtracted: 0,
        estimatedCostCny: 0,
        status: 'error',
        error: err instanceof Error ? err.message.slice(0, 180) : '生成清洗规则失败',
      });
    }
    const message = err instanceof Error ? err.message : '生成清洗规则失败';
    console.error('[clean-rules error]', err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/reconcile-suggest', async (req, res) => {
  const leftHeaders: string[] = Array.isArray(req.body?.leftHeaders)
    ? req.body.leftHeaders.map((x: unknown) => String(x ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 40)
    : [];
  const rightHeaders: string[] = Array.isArray(req.body?.rightHeaders)
    ? req.body.rightHeaders.map((x: unknown) => String(x ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 40)
    : [];

  try {
    const clientIp = getClientIp(req);
    const ipCheck = quotaStore.checkIpRateLimit(clientIp, 'reconcile_suggest', 12);
    if (!ipCheck.allowed) {
      res.status(429).json({ error: `请求过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
      return;
    }

    if (leftHeaders.length === 0 || rightHeaders.length === 0) {
      res.status(400).json({ error: '缺少左右两表的表头列表' });
      return;
    }

    const fallback = suggestReconcileMapping(leftHeaders, rightHeaders);
    const llm = runtimeConfig.getEffective();
    if (!llm.apiKey) {
      res.json({ ok: true, mode: 'heuristic', mapping: fallback });
      return;
    }

    const { userId } = getUserHeaders(req);
    const baseUrl = await assertPublicHttpsBaseUrl(llm.baseUrl);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.freeModel,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是表格对账列名对齐专家。给定表A和表B的列名，找出最适合作为对账主键的一对列，以及需要核对差异的列对。仅输出 JSON：{"leftKeyCol":"...","rightKeyCol":"...","comparePairs":[{"leftCol":"...","rightCol":"..."}]}，列名必须严格来自输入列表。',
          },
          {
            role: 'user',
            content: `表A列名：${JSON.stringify(leftHeaders)}\n表B列名：${JSON.stringify(rightHeaders)}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const friendly = formatFriendlyLlmError(response.status, errText, llm.freeModel);
      res.json({ ok: true, mode: 'heuristic', fallbackReason: friendly, mapping: fallback });
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = data.choices?.[0]?.message?.content;
    const parsed = raw
      ? parseFirstJsonObject<{
          leftKeyCol?: string;
          rightKeyCol?: string;
          comparePairs?: Array<{ leftCol: string; rightCol: string }>;
        }>(raw)
      : null;

    const costCny = estimateModelCostCny(
      llm.freeModel,
      data.usage?.prompt_tokens ?? 0,
      data.usage?.completion_tokens ?? 0
    );
    quotaStore.recordLog({
      userId,
      tier: 'free',
      mode: 'llm',
      model: llm.freeModel,
      pages: 0,
      rowsExtracted: 0,
      estimatedCostCny: costCny,
      status: 'ok',
    });

    if (!parsed) {
      res.json({
        ok: true,
        mode: 'heuristic',
        fallbackReason: 'AI 返回格式未识别，已自动使用本地规则对齐',
        mapping: fallback,
      });
      return;
    }

    const leftSet = new Set(leftHeaders);
    const rightSet = new Set(rightHeaders);
    const leftKeyCol = parsed.leftKeyCol && leftSet.has(parsed.leftKeyCol) ? parsed.leftKeyCol : fallback.leftKeyCol;
    const rightKeyCol = parsed.rightKeyCol && rightSet.has(parsed.rightKeyCol) ? parsed.rightKeyCol : fallback.rightKeyCol;
    const comparePairs = Array.isArray(parsed.comparePairs)
      ? parsed.comparePairs.filter(
          (p) =>
            p &&
            leftSet.has(p.leftCol) &&
            rightSet.has(p.rightCol) &&
            (p.leftCol !== leftKeyCol || p.rightCol !== rightKeyCol)
        )
      : fallback.comparePairs;

    res.json({
      ok: true,
      mode: 'llm',
      mapping: { leftKeyCol, rightKeyCol, comparePairs },
    });
  } catch {
    res.json({
      ok: true,
      mode: 'heuristic',
      fallbackReason: 'AI 暂不可用，已自动使用本地规则对齐',
      mapping: suggestReconcileMapping(leftHeaders, rightHeaders),
    });
  }
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const msg =
        err.code === 'LIMIT_FILE_COUNT'
          ? '单次上传页数超过服务端上限（最多 25 页/图），请分批提交'
          : err.code === 'LIMIT_FILE_SIZE'
            ? '单个文件超过 15MB 大小限制'
            : `文件上传格式异常: ${err.message}`;
      res.status(status).json({ error: msg });
      return;
    }

    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: '请求体 JSON 格式错误' });
      return;
    }

    console.error('[unhandled error]', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  }
);

app.listen(PORT, () => {
  const llm = runtimeConfig.getEffective();
  console.log(`[any-to-sheet-server] running at http://localhost:${PORT}`);
  console.log(`[any-to-sheet-server] admin console: http://localhost:${PORT}/admin`);
  console.log(
    `[any-to-sheet-server] mode: ${llm.apiKey ? `LLM (free=${llm.freeModel}, pro=${llm.proModel}, key=${llm.apiKeySource})` : 'MOCK DEMO (默认开发后台密钥: dev-admin-123)'}`
  );
  console.log(
    `[any-to-sheet-server] quota policy: welcome=${llm.freeWelcomePages} + daily=${llm.freeDailyPages} pages/day, ipDailyCap=${llm.ipDailyFreeLimit}, globalDailyFreeCap=${llm.globalDailyFreeLimit}, trustProxy=${TRUST_PROXY}, configEncryption=${runtimeConfig.encryptionReady}`
  );
});

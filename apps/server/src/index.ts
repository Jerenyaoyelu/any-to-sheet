import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {
  buildExtractionPrompt,
  validateExtractionItems,
  type ExtractionRawItem,
  type ExtractResponse,
  type TableSchema,
} from '@table-ai/core';
import { QuotaStore } from './quotaStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT || 3001);
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY?.trim() || '';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen-vl-max-latest';
const LLM_FREE_MODEL = process.env.LLM_FREE_MODEL?.trim() || LLM_MODEL;
const LLM_PRO_MODEL = process.env.LLM_PRO_MODEL?.trim() || LLM_MODEL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || '';

const quotaStore = new QuotaStore(path.resolve(__dirname, '../data/quota-store.json'), {
  freeWelcomePages: Number(process.env.FREE_WELCOME_PAGES ?? 8),
  freeDailyPages: Number(process.env.FREE_DAILY_PAGES ?? 2),
  globalDailyFreeLimit: Number(process.env.GLOBAL_DAILY_FREE_LIMIT ?? 1000),
  ipDailyFreeLimit: Number(process.env.IP_DAILY_FREE_LIMIT ?? 30),
  freeMaxFiles: 3,
  proMaxFiles: 20,
  freeMaxPdfPages: 3,
  proMaxPdfPages: 10,
  isMockMode: !LLM_API_KEY,
});

function getClientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
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

function decodeFileName(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : trimmed;
}

/**
 * Generates realistic schema-aware demo items when LLM_API_KEY is not yet configured.
 * Includes a deliberate low-confidence / math-check warning so users can test the yellow review UX.
 */
function generateMockItems(schema: TableSchema, fileNames: string[]): ExtractionRawItem[] {
  const writableFields = schema.fields.filter((f) => !f.readonly && f.type !== 'unknown');
  const results: ExtractionRawItem[] = [];

  fileNames.forEach((fileName, fileIndex) => {
    const rowCount = fileIndex === 0 ? 2 : 1;
    for (let i = 0; i < rowCount; i++) {
      const values: Record<string, unknown> = {};
      const confidence: Record<string, number> = {};

      for (const field of writableFields) {
        const name = field.name;
        if (field.type === 'number') {
          if (/数量|件数|qty/i.test(name)) {
            values[name] = i === 0 ? 10 : 5;
            confidence[name] = 0.96;
          } else if (/单价|price/i.test(name)) {
            values[name] = i === 0 ? 128.5 : 240;
            confidence[name] = 0.94;
          } else if (/总价|金额|合计|total|amount/i.test(name)) {
            // Deliberately introduce a minor mismatch on the second row to showcase arithmetic validation
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
        } else {
          values[name] = `${fileName.replace(/\.[^.]+$/, '')} - 示例项${i + 1}`;
          confidence[name] = i === 0 ? 0.95 : 0.76;
        }
      }

      results.push({
        sourceFileName: fileName,
        values,
        confidence,
        notes:
          i === 1
            ? 'Mock 演示模式：已故意构造低置信度或金额核对异常，展示标黄复核效果'
            : undefined,
      });
    }
  });

  return results;
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
        text: `【文档文件：${cleanName} (${file.mimetype})】\n${readableText || '（二进制文件，建议前端转图片或后端接入 PDF 转图服务后识别）'}`,
      });
    }
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API 调用失败 (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('大模型未返回有效内容');
  }

  const parsed = JSON.parse(stripJsonFence(rawContent)) as { items?: ExtractionRawItem[] };
  if (!Array.isArray(parsed.items)) {
    throw new Error('大模型返回 JSON 缺少 items 数组');
  }

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
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_ATTACHMENT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: LLM_API_KEY ? 'llm' : 'mock',
    freeModel: LLM_API_KEY ? LLM_FREE_MODEL : 'mock-demo',
    proModel: LLM_API_KEY ? LLM_PRO_MODEL : 'mock-demo',
  });
});

/** Query current user's remaining quota & tier limits */
app.get('/api/quota', (req, res) => {
  const { userId, tenantKey } = getUserHeaders(req);
  const snapshot = quotaStore.getSnapshot(userId, tenantKey);
  res.json({
    mode: LLM_API_KEY ? 'llm' : 'mock',
    quota: snapshot,
  });
});

/** Redeem a Pro activation code to add permanent paid pages */
app.post('/api/quota/redeem', (req, res) => {
  const ipCheck = quotaStore.checkIpRateLimit(getClientIp(req), 8);
  if (!ipCheck.allowed) {
    res.status(429).json({ error: `操作过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
    return;
  }

  const { userId, tenantKey } = getUserHeaders(req);
  const { code } = req.body as { code?: string };
  const result = quotaStore.redeemCode(userId, code || '', tenantKey);

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

/** Admin endpoint: batch-generate Pro redemption codes (requires x-admin-token header) */
app.post('/api/admin/codes/generate', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_TOKEN || ADMIN_TOKEN === 'change-me-in-production' || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: '未配置有效 ADMIN_TOKEN 或鉴权失败' });
    return;
  }

  const { count = 10, pages = 100, note } = req.body as {
    count?: number;
    pages?: number;
    note?: string;
  };
  const created = quotaStore.generateCodes(Number(count), Number(pages), note);
  res.json({ ok: true, count: created.length, codes: created });
});

/**
 * Safely proxies Feishu temporary attachment URLs to bypass browser CORS restrictions
 * when converting PDF attachments to images on the client side.
 */
app.post('/api/fetch-attachment', async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url || !isAllowedAttachmentUrl(url)) {
      res.status(400).json({ error: '仅允许代理合法的飞书附件 HTTPS 地址' });
      return;
    }

    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({ error: `拉取飞书附件失败 (${upstream.status})` });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    if (buf.byteLength > 20 * 1024 * 1024) {
      res.status(413).json({ error: '单个附件超过 20MB 限制' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.send(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : '附件拉取失败';
    res.status(500).json({ error: message });
  }
});

app.post('/api/extract', upload.array('files', 25), async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const ipCheck = quotaStore.checkIpRateLimit(clientIp, 10);
    if (!ipCheck.allowed) {
      res.status(429).json({ error: `请求过于频繁，请 ${ipCheck.retryAfterSec} 秒后再试` });
      return;
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: '请至少上传一个文件（图片/截图/文本/PDF）' });
      return;
    }

    const schemaRaw = req.body?.schema;
    if (!schemaRaw) {
      res.status(400).json({ error: '缺少目标表格 Schema 结构' });
      return;
    }

    const { userId, tenantKey } = getUserHeaders(req);
    const pageCost = files.length;
    const quotaCheck = quotaStore.canConsume(userId, pageCost, tenantKey, clientIp);

    if (!quotaCheck.allowed) {
      res.status(quotaCheck.statusCode).json({
        error: quotaCheck.error,
        quota: quotaCheck.snapshot,
      });
      return;
    }

    const schema = JSON.parse(schemaRaw) as TableSchema;
    const userHint = typeof req.body?.userHint === 'string' ? req.body.userHint : undefined;
    const fileNames = files.map((f) => decodeFileName(f.originalname));

    const chosenModel = quotaCheck.useProModel ? LLM_PRO_MODEL : LLM_FREE_MODEL;

    let items: ExtractionRawItem[];
    let mode: 'llm' | 'mock' = 'mock';
    let promptTokens = 0;
    let completionTokens = 0;

    if (LLM_API_KEY) {
      mode = 'llm';
      const llmRes = await callMultimodalLLM(chosenModel, schema, files, userHint);
      items = llmRes.items;
      promptTokens = llmRes.promptTokens ?? 0;
      completionTokens = llmRes.completionTokens ?? 0;
    } else {
      items = generateMockItems(schema, fileNames);
    }

    const validatedRows = validateExtractionItems(schema, items);

    // Deduct quota ONLY after extraction succeeds so failed requests never burn user pages
    const updatedQuota = quotaStore.consume(userId, pageCost, tenantKey, clientIp);

    const estimatedCostCny =
      mode === 'llm'
        ? Number(((promptTokens / 1000) * 0.003 + (completionTokens / 1000) * 0.009).toFixed(4))
        : 0;

    const payload: ExtractResponse = {
      mode,
      model: mode === 'llm' ? chosenModel : 'mock-demo（未配置 LLM_API_KEY）',
      rows: validatedRows,
      estimatedCostCny,
      consumedPages: pageCost,
      quota: updatedQuota,
      usage: mode === 'llm' ? { promptTokens, completionTokens } : undefined,
    };

    res.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知提取错误';
    console.error('[extract error]', err);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`[any-to-sheet-server] running at http://localhost:${PORT}`);
  console.log(
    `[any-to-sheet-server] mode: ${LLM_API_KEY ? `LLM (free=${LLM_FREE_MODEL}, pro=${LLM_PRO_MODEL})` : 'MOCK DEMO (在 apps/server/.env 中配置 LLM_API_KEY 后切换为真实模型)'}`
  );
  console.log(
    `[any-to-sheet-server] quota policy: welcome=${process.env.FREE_WELCOME_PAGES ?? 8} + daily=${process.env.FREE_DAILY_PAGES ?? 2} pages/day, globalDailyFreeCap=${process.env.GLOBAL_DAILY_FREE_LIMIT ?? 1000}`
  );
});

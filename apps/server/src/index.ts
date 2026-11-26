import 'dotenv/config';
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
      // Fallback for PDF / Office binaries in MVP: pass UTF-8 readable strings or notify user to convert/upgrade PDF renderer
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
      model: LLM_MODEL,
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
    model: LLM_API_KEY ? LLM_MODEL : 'mock-demo',
  });
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

    const schema = JSON.parse(schemaRaw) as TableSchema;
    const userHint = typeof req.body?.userHint === 'string' ? req.body.userHint : undefined;
    const fileNames = files.map((f) => decodeFileName(f.originalname));

    let items: ExtractionRawItem[];
    let mode: 'llm' | 'mock' = 'mock';
    let promptTokens = 0;
    let completionTokens = 0;

    if (LLM_API_KEY) {
      mode = 'llm';
      const llmRes = await callMultimodalLLM(schema, files, userHint);
      items = llmRes.items;
      promptTokens = llmRes.promptTokens ?? 0;
      completionTokens = llmRes.completionTokens ?? 0;
    } else {
      items = generateMockItems(schema, fileNames);
    }

    const validatedRows = validateExtractionItems(schema, items);

    // Rough cost estimation in CNY (~¥0.003 per 1k input tokens, ~¥0.009 per 1k output tokens for VL models)
    const estimatedCostCny =
      mode === 'llm'
        ? Number(((promptTokens / 1000) * 0.003 + (completionTokens / 1000) * 0.009).toFixed(4))
        : 0;

    const payload: ExtractResponse = {
      mode,
      model: mode === 'llm' ? LLM_MODEL : 'mock-demo（未配置 LLM_API_KEY）',
      rows: validatedRows,
      estimatedCostCny,
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
    `[any-to-sheet-server] mode: ${LLM_API_KEY ? `LLM (${LLM_MODEL})` : 'MOCK DEMO (在 apps/server/.env 中配置 LLM_API_KEY 后切换为真实模型)'}`
  );
});

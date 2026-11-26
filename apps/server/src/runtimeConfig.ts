import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_AUDIT = 40;
const MODEL_PATTERN = /^[A-Za-z0-9_.:/@+-]{0,128}$/;

export interface RuntimeConfigDefaults {
  llmBaseUrl: string;
  llmModel: string;
  llmFreeModel: string;
  llmProModel: string;
  llmApiKey: string;
  freeWelcomePages: number;
  freeDailyPages: number;
  globalDailyFreeLimit: number;
  ipDailyFreeLimit: number;
  encryptionKey: string;
}

export interface EffectiveRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  freeModel: string;
  proModel: string;
  freeWelcomePages: number;
  freeDailyPages: number;
  globalDailyFreeLimit: number;
  ipDailyFreeLimit: number;
  apiKeySource: 'admin' | 'env' | 'none' | 'unreadable';
}

export interface PublicRuntimeSettings {
  llmBaseUrl: string;
  llmModel: string;
  llmFreeModel: string;
  llmProModel: string;
  freeWelcomePages: number;
  freeDailyPages: number;
  globalDailyFreeLimit: number;
  ipDailyFreeLimit: number;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  apiKeySource: EffectiveRuntimeConfig['apiKeySource'];
  encryptionReady: boolean;
  encryptionHint: string;
  usingMock: boolean;
  updatedAt: string | null;
  audit: Array<{ at: string; summary: string }>;
}

export interface RuntimeSettingsPatch {
  llmBaseUrl: string;
  llmModel: string;
  llmFreeModel: string;
  llmProModel: string;
  freeWelcomePages: number;
  freeDailyPages: number;
  globalDailyFreeLimit: number;
  ipDailyFreeLimit: number;
  llmApiKey?: string;
  clearApiKey?: boolean;
}

interface StoredCipher {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface RuntimeConfigFile {
  llmBaseUrl?: string;
  llmModel?: string;
  llmFreeModel?: string;
  llmProModel?: string;
  freeWelcomePages?: number;
  freeDailyPages?: number;
  globalDailyFreeLimit?: number;
  ipDailyFreeLimit?: number;
  /** Present when an admin has taken over the key, including an explicit clear. */
  apiKeyManaged?: boolean;
  apiKey?: StoredCipher | null;
  updatedAt?: string;
  audit?: Array<{ at: string; summary: string }>;
}

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (kind === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

export async function assertPublicHttpsBaseUrl(raw: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('模型地址不是合法 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('模型地址只允许 https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('模型地址不能包含账号或密码');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('模型地址不能带查询参数');
  }
  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname) || (net.isIP(hostname) && isBlockedIp(hostname))) {
    throw new Error('模型地址不能指向本机或内网');
  }
  if (!net.isIP(hostname)) {
    let records: Array<{ address: string }>;
    try {
      records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('模型地址无法解析，请检查域名');
    }
    if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
      throw new Error('模型地址解析到了内网或保留地址');
    }
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseBoundedInt(value: unknown, label: string, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数`);
  }
  return num;
}

function parseModel(value: unknown, label: string, allowEmpty: boolean): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} 格式无效`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new Error(`请填写${label}`);
  }
  if (!MODEL_PATTERN.test(trimmed)) {
    throw new Error(`${label} 含有不支持的字符`);
  }
  return trimmed;
}

function maskKey(key: string): string {
  if (key.length < 8) return '已配置';
  return `已配置，末尾 ${key.slice(-4)}`;
}

function encryptSecret(plain: string, passphrase: string): StoredCipher {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(stored: StoredCipher, passphrase: string): string {
  const salt = Buffer.from(stored.salt, 'base64');
  const iv = Buffer.from(stored.iv, 'base64');
  const tag = Buffer.from(stored.tag, 'base64');
  const ciphertext = Buffer.from(stored.ciphertext, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export class RuntimeConfigStore {
  private readonly filePath: string;
  private readonly defaults: RuntimeConfigDefaults;
  private file: RuntimeConfigFile = {};
  private cachedAdminKey = '';
  private adminKeyReadable = true;

  constructor(filePath: string, defaults: RuntimeConfigDefaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.file = this.load();
    this.refreshAdminKeyCache();
  }

  get encryptionReady(): boolean {
    return this.defaults.encryptionKey.length >= 16;
  }

  getEffective(): EffectiveRuntimeConfig {
    const model = this.file.llmModel?.trim() || this.defaults.llmModel;
    const freeModel = this.file.llmFreeModel !== undefined
      ? this.file.llmFreeModel.trim() || model
      : this.defaults.llmFreeModel || model;
    const proModel = this.file.llmProModel !== undefined
      ? this.file.llmProModel.trim() || model
      : this.defaults.llmProModel || model;

    let apiKey = '';
    let apiKeySource: EffectiveRuntimeConfig['apiKeySource'] = 'none';
    if (this.file.apiKeyManaged) {
      if (!this.adminKeyReadable) {
        apiKeySource = 'unreadable';
      } else if (this.cachedAdminKey) {
        apiKey = this.cachedAdminKey;
        apiKeySource = 'admin';
      }
    } else if (this.defaults.llmApiKey) {
      apiKey = this.defaults.llmApiKey;
      apiKeySource = 'env';
    }

    return {
      baseUrl: (this.file.llmBaseUrl || this.defaults.llmBaseUrl).replace(/\/$/, ''),
      apiKey,
      model,
      freeModel,
      proModel,
      freeWelcomePages: this.file.freeWelcomePages ?? this.defaults.freeWelcomePages,
      freeDailyPages: this.file.freeDailyPages ?? this.defaults.freeDailyPages,
      globalDailyFreeLimit: this.file.globalDailyFreeLimit ?? this.defaults.globalDailyFreeLimit,
      ipDailyFreeLimit: this.file.ipDailyFreeLimit ?? this.defaults.ipDailyFreeLimit,
      apiKeySource,
    };
  }

  getPublicSettings(): PublicRuntimeSettings {
    const effective = this.getEffective();
    return {
      llmBaseUrl: effective.baseUrl,
      llmModel: effective.model,
      llmFreeModel: this.file.llmFreeModel ?? (this.defaults.llmFreeModel === effective.model ? '' : this.defaults.llmFreeModel),
      llmProModel: this.file.llmProModel ?? (this.defaults.llmProModel === effective.model ? '' : this.defaults.llmProModel),
      freeWelcomePages: effective.freeWelcomePages,
      freeDailyPages: effective.freeDailyPages,
      globalDailyFreeLimit: effective.globalDailyFreeLimit,
      ipDailyFreeLimit: effective.ipDailyFreeLimit,
      apiKeyConfigured: effective.apiKeySource === 'admin' || effective.apiKeySource === 'env' || effective.apiKeySource === 'unreadable',
      apiKeyHint:
        effective.apiKeySource === 'unreadable'
          ? '已保存的密钥无法解密，请重新填写'
          : effective.apiKey
            ? maskKey(effective.apiKey)
            : '未配置',
      apiKeySource: effective.apiKeySource,
      encryptionReady: this.encryptionReady,
      encryptionHint: this.encryptionReady
        ? '模型密钥会用 AES-256-GCM 加密后写入数据文件。留空表示不修改。'
        : '服务器未设置至少 16 位的 CONFIG_ENCRYPTION_KEY，暂时不能在后台保存模型密钥。',
      usingMock: !effective.apiKey,
      updatedAt: this.file.updatedAt ?? null,
      audit: Array.isArray(this.file.audit) ? this.file.audit.slice(0, 8) : [],
    };
  }

  async update(patch: RuntimeSettingsPatch): Promise<PublicRuntimeSettings> {
    const llmBaseUrl = await assertPublicHttpsBaseUrl(patch.llmBaseUrl);
    const llmModel = parseModel(patch.llmModel, '默认模型', false);
    const llmFreeModel = parseModel(patch.llmFreeModel, '免费模型', true);
    const llmProModel = parseModel(patch.llmProModel, 'Pro 模型', true);
    const freeWelcomePages = parseBoundedInt(patch.freeWelcomePages, '新人体验页数', 0, 10000);
    const freeDailyPages = parseBoundedInt(patch.freeDailyPages, '每日免费页数', 0, 10000);
    const globalDailyFreeLimit = parseBoundedInt(patch.globalDailyFreeLimit, '全站每日免费上限', 0, 1_000_000);
    const ipDailyFreeLimit = parseBoundedInt(patch.ipDailyFreeLimit, '单 IP 每日免费上限', 0, 100_000);

    const nextKey = typeof patch.llmApiKey === 'string' ? patch.llmApiKey.trim() : '';
    const clearApiKey = patch.clearApiKey === true;
    if (clearApiKey && nextKey) {
      throw new Error('不能同时填写新密钥和清除密钥');
    }
    if (nextKey && !this.encryptionReady) {
      throw new Error('请先在服务器环境变量设置至少 16 位的 CONFIG_ENCRYPTION_KEY，再保存模型密钥');
    }

    const changes: string[] = [];
    this.file.llmBaseUrl = llmBaseUrl;
    this.file.llmModel = llmModel;
    this.file.llmFreeModel = llmFreeModel;
    this.file.llmProModel = llmProModel;
    this.file.freeWelcomePages = freeWelcomePages;
    this.file.freeDailyPages = freeDailyPages;
    this.file.globalDailyFreeLimit = globalDailyFreeLimit;
    this.file.ipDailyFreeLimit = ipDailyFreeLimit;
    changes.push(`模型地址 ${llmBaseUrl}`);
    changes.push(`默认模型 ${llmModel}`);
    changes.push(`免费模型 ${llmFreeModel || '跟随默认模型'}`);
    changes.push(`Pro 模型 ${llmProModel || '跟随默认模型'}`);
    changes.push(
      `额度 新人 ${freeWelcomePages} / 每日 ${freeDailyPages} / 全站 ${globalDailyFreeLimit} / 单 IP ${ipDailyFreeLimit}`
    );

    if (nextKey) {
      this.file.apiKeyManaged = true;
      this.file.apiKey = encryptSecret(nextKey, this.defaults.encryptionKey);
      this.cachedAdminKey = nextKey;
      this.adminKeyReadable = true;
      changes.push('已更新模型密钥');
    } else if (clearApiKey) {
      this.file.apiKeyManaged = true;
      this.file.apiKey = null;
      this.cachedAdminKey = '';
      this.adminKeyReadable = true;
      changes.push('已清除模型密钥，不再使用环境变量中的密钥');
    }

    const at = new Date().toISOString();
    this.file.updatedAt = at;
    const audit = Array.isArray(this.file.audit) ? this.file.audit : [];
    audit.unshift({ at, summary: changes.join('；') });
    this.file.audit = audit.slice(0, MAX_AUDIT);
    this.save();
    return this.getPublicSettings();
  }

  private load(): RuntimeConfigFile {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RuntimeConfigFile;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (err) {
      console.warn('[runtime-config] failed to read config, using environment defaults:', err);
      return {};
    }
  }

  private refreshAdminKeyCache(): void {
    this.cachedAdminKey = '';
    this.adminKeyReadable = true;
    if (!this.file.apiKeyManaged || !this.file.apiKey) return;
    if (!this.encryptionReady) {
      this.adminKeyReadable = false;
      console.error('[runtime-config] stored model key cannot be decrypted: CONFIG_ENCRYPTION_KEY is missing');
      return;
    }
    try {
      this.cachedAdminKey = decryptSecret(this.file.apiKey, this.defaults.encryptionKey);
    } catch (err) {
      this.adminKeyReadable = false;
      console.error('[runtime-config] stored model key cannot be decrypted');
      if (err instanceof Error) {
        console.error('[runtime-config] decrypt error name:', err.name);
      }
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.file, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }
}

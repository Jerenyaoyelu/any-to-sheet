import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { QuotaSnapshot } from '@table-ai/core';

export interface QuotaConfig {
  /** One-time welcome pages granted on first visit (plus Day-1 daily pages = 10 total on Day 1) */
  freeWelcomePages: number;
  /** Daily refreshing free pages (non-cumulative) */
  freeDailyPages: number;
  /** Global free-channel daily circuit breaker (protects against overnight viral/bot bill spikes) */
  globalDailyFreeLimit: number;
  /** Per-IP daily free-channel cap (prevents spoofed x-user-id abuse while allowing ~3 colleagues on office NAT) */
  ipDailyFreeLimit: number;
  /** Single-request file caps */
  freeMaxFiles: number;
  proMaxFiles: number;
  freeMaxPdfPages: number;
  proMaxPdfPages: number;
  /** Whether server is running in mock mode (enables built-in demo code ATS-DEMO-100) */
  isMockMode: boolean;
}

interface UserQuotaRecord {
  userId: string;
  tenantKey?: string;
  welcomeRemaining: number;
  dailyDate: string;
  dailyUsed: number;
  paidRemaining: number;
  totalUsedPages: number;
  createdAt: string;
  lastActiveAt: string;
}

interface RedeemCodeRecord {
  code: string;
  pages: number;
  note?: string;
  createdAt: string;
  redeemedBy?: string;
  redeemedAt?: string;
}

interface PersistedStore {
  users: Record<string, UserQuotaRecord>;
  codes: Record<string, RedeemCodeRecord>;
  globalDailyFree: {
    date: string;
    usedPages: number;
  };
  ipDailyFree: {
    date: string;
    byIp: Record<string, number>;
  };
}

function getTodayStr(): string {
  // Use Asia/Shanghai date string (YYYY-MM-DD) for Chinese users
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

export class QuotaStore {
  private readonly filePath: string;
  private readonly config: QuotaConfig;
  private data: PersistedStore;
  private readonly ipBuckets = new Map<string, number[]>();

  constructor(filePath: string, config: QuotaConfig) {
    this.filePath = filePath;
    this.config = config;
    this.data = this.load();
  }

  private load(): PersistedStore {
    const today = getTodayStr();
    const empty: PersistedStore = {
      users: {},
      codes: {},
      globalDailyFree: { date: today, usedPages: 0 },
      ipDailyFree: { date: today, byIp: {} },
    };

    try {
      if (!fs.existsSync(this.filePath)) {
        return empty;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedStore>;
      return {
        users: parsed.users || {},
        codes: parsed.codes || {},
        globalDailyFree: parsed.globalDailyFree || { date: today, usedPages: 0 },
        ipDailyFree: parsed.ipDailyFree || { date: today, byIp: {} },
      };
    } catch (err) {
      console.warn('[quota-store] failed to read store, initializing fresh store:', err);
      return empty;
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[quota-store] failed to persist store:', err);
    }
  }

  private syncDateBuckets(user: UserQuotaRecord): void {
    const today = getTodayStr();
    if (user.dailyDate !== today) {
      user.dailyDate = today;
      user.dailyUsed = 0;
    }
    if (this.data.globalDailyFree.date !== today) {
      this.data.globalDailyFree = { date: today, usedPages: 0 };
    }
    if (this.data.ipDailyFree.date !== today) {
      this.data.ipDailyFree = { date: today, byIp: {} };
    }
  }

  private getOrCreateUser(userId: string, tenantKey?: string): UserQuotaRecord {
    const cleanId = userId.trim().slice(0, 128) || 'anonymous';
    const today = getTodayStr();
    let user = this.data.users[cleanId];
    if (!user) {
      user = {
        userId: cleanId,
        tenantKey,
        welcomeRemaining: this.config.freeWelcomePages,
        dailyDate: today,
        dailyUsed: 0,
        paidRemaining: 0,
        totalUsedPages: 0,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };
      this.data.users[cleanId] = user;
      this.save();
    } else if (tenantKey && !user.tenantKey) {
      user.tenantKey = tenantKey;
    }
    this.syncDateBuckets(user);
    return user;
  }

  /** Sliding-window IP rate limiter (protects /api/extract and /api/quota/redeem from abuse) */
  checkIpRateLimit(ip: string, maxRequestsPerMinute = 10): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const prev = (this.ipBuckets.get(ip) || []).filter((ts) => now - ts < windowMs);
    if (prev.length >= maxRequestsPerMinute) {
      const oldest = prev[0];
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      this.ipBuckets.set(ip, prev);
      return { allowed: false, retryAfterSec };
    }
    prev.push(now);
    this.ipBuckets.set(ip, prev);
    return { allowed: true };
  }

  getSnapshot(userId: string, tenantKey?: string): QuotaSnapshot {
    const user = this.getOrCreateUser(userId, tenantKey);
    const dailyRemaining = Math.max(0, this.config.freeDailyPages - user.dailyUsed);
    const globalFreeRemainingToday = Math.max(
      0,
      this.config.globalDailyFreeLimit - this.data.globalDailyFree.usedPages
    );
    const isPro = user.paidRemaining > 0;
    const totalAvailable = dailyRemaining + user.welcomeRemaining + user.paidRemaining;

    return {
      userId: user.userId,
      tier: isPro ? 'pro' : 'free',
      dailyRemaining,
      dailyLimit: this.config.freeDailyPages,
      welcomeRemaining: user.welcomeRemaining,
      paidRemaining: user.paidRemaining,
      totalAvailable,
      maxFilesPerRequest: isPro ? this.config.proMaxFiles : this.config.freeMaxFiles,
      maxPdfPages: isPro ? this.config.proMaxPdfPages : this.config.freeMaxPdfPages,
      globalFreeRemainingToday,
    };
  }

  /**
   * Validates whether the user can process `pageCount` pages right now (before invoking LLM).
   * Returns `useProModel` so the server can route Pro users to higher-accuracy flagship VL models.
   */
  canConsume(
    userId: string,
    pageCount: number,
    tenantKey?: string,
    clientIp?: string
  ): { allowed: true; useProModel: boolean; snapshot: QuotaSnapshot } | { allowed: false; statusCode: number; error: string; snapshot: QuotaSnapshot } {
    const snapshot = this.getSnapshot(userId, tenantKey);

    if (pageCount <= 0) {
      return { allowed: false, statusCode: 400, error: '待识别页数必须大于 0', snapshot };
    }

    if (pageCount > snapshot.maxFilesPerRequest) {
      return {
        allowed: false,
        statusCode: 403,
        error:
          snapshot.tier === 'free'
            ? `免费版单次最多处理 ${snapshot.maxFilesPerRequest} 页/图（本次 ${pageCount} 页）。请减少单次上传数量，或兑换激活码升级 Pro 解锁单次 ${this.config.proMaxFiles} 页。`
            : `单次最多处理 ${snapshot.maxFilesPerRequest} 页/图（本次 ${pageCount} 页），请分批提交。`,
        snapshot,
      };
    }

    if (snapshot.totalAvailable < pageCount) {
      return {
        allowed: false,
        statusCode: 402,
        error: `当前剩余额度不足（剩余 ${snapshot.totalAvailable} 页，本次需要 ${pageCount} 页）。请明天再来领取每日免费额度，或点击右上角「兑换激活码」充值。`,
        snapshot,
      };
    }

    // Check per-IP and global daily free-channel caps ONLY if this request relies on free pages
    const freeNeeded = Math.max(0, pageCount - snapshot.paidRemaining);
    if (freeNeeded > 0) {
      if (clientIp) {
        const ipUsed = this.data.ipDailyFree.byIp[clientIp] || 0;
        if (ipUsed + freeNeeded > this.config.ipDailyFreeLimit) {
          return {
            allowed: false,
            statusCode: 429,
            error: `当前网络环境今日免费额度已达上限（单 IP 每日最多 ${this.config.ipDailyFreeLimit} 页），请明日再试，或兑换 Pro 激活码（付费额度不受 IP 限制）。`,
            snapshot,
          };
        }
      }
      if (snapshot.globalFreeRemainingToday < freeNeeded) {
        return {
          allowed: false,
          statusCode: 429,
          error: '今日全站免费通道额度已达保护上限，请明日再试，或兑换 Pro 激活码走专属高速通道（不受限）。',
          snapshot,
        };
      }
    }

    return {
      allowed: true,
      useProModel: snapshot.tier === 'pro',
      snapshot,
    };
  }

  /**
   * Deducts pages ONLY after LLM extraction succeeds.
   * Priority: daily expiring free -> welcome one-time free -> permanent paid credits.
   */
  consume(userId: string, pageCount: number, tenantKey?: string, clientIp?: string): QuotaSnapshot {
    const user = this.getOrCreateUser(userId, tenantKey);
    let left = pageCount;

    const dailyAvail = Math.max(0, this.config.freeDailyPages - user.dailyUsed);
    const useDaily = Math.min(left, dailyAvail);
    user.dailyUsed += useDaily;
    left -= useDaily;

    const useWelcome = Math.min(left, user.welcomeRemaining);
    user.welcomeRemaining -= useWelcome;
    left -= useWelcome;

    const freeUsed = useDaily + useWelcome;
    if (freeUsed > 0) {
      this.data.globalDailyFree.usedPages += freeUsed;
      if (clientIp) {
        this.data.ipDailyFree.byIp[clientIp] = (this.data.ipDailyFree.byIp[clientIp] || 0) + freeUsed;
      }
    }

    if (left > 0) {
      user.paidRemaining = Math.max(0, user.paidRemaining - left);
    }

    user.totalUsedPages += pageCount;
    user.lastActiveAt = new Date().toISOString();
    this.save();

    return this.getSnapshot(userId, tenantKey);
  }

  generateCodes(count: number, pages: number, note?: string): RedeemCodeRecord[] {
    const created: RedeemCodeRecord[] = [];
    const safeCount = Math.min(Math.max(1, count), 200);
    const safePages = Math.min(Math.max(1, pages), 100000);

    for (let i = 0; i < safeCount; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `ATS-${part1}-${part2}`;
      const record: RedeemCodeRecord = {
        code,
        pages: safePages,
        note,
        createdAt: new Date().toISOString(),
      };
      this.data.codes[code] = record;
      created.push(record);
    }
    this.save();
    return created;
  }

  redeemCode(
    userId: string,
    rawCode: string,
    tenantKey?: string
  ): { ok: true; addedPages: number; snapshot: QuotaSnapshot } | { ok: false; error: string } {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      return { ok: false, error: '请输入激活码' };
    }

    const user = this.getOrCreateUser(userId, tenantKey);

    // Built-in demo code for local testing ONLY when LLM_API_KEY is not configured
    if (this.config.isMockMode && code === 'ATS-DEMO-100') {
      user.paidRemaining += 100;
      user.lastActiveAt = new Date().toISOString();
      this.save();
      return { ok: true, addedPages: 100, snapshot: this.getSnapshot(userId, tenantKey) };
    }

    const record = this.data.codes[code];
    if (!record) {
      return { ok: false, error: '激活码无效，请检查拼写是否正确' };
    }
    if (record.redeemedBy) {
      return { ok: false, error: '该激活码已被使用，无法重复兑换' };
    }

    record.redeemedBy = user.userId;
    record.redeemedAt = new Date().toISOString();
    user.paidRemaining += record.pages;
    user.lastActiveAt = new Date().toISOString();
    this.save();

    return {
      ok: true,
      addedPages: record.pages,
      snapshot: this.getSnapshot(userId, tenantKey),
    };
  }
}

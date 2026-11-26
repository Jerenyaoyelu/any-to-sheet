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

interface DeductionPlan {
  usePaid: number;
  useDaily: number;
  useWelcome: number;
  freeUsed: number;
  useProModel: boolean;
}

export interface QuotaReservation {
  id: string;
  userId: string;
  tenantKey?: string;
  clientIp?: string;
  pageCount: number;
  plan: DeductionPlan;
  createdAt: number;
}

const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

function sanitizeKey(raw: string, fallback = 'anonymous'): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
  if (!cleaned || FORBIDDEN_KEYS.has(cleaned)) {
    return `${fallback}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  }
  return cleaned;
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
  private readonly pendingReservations = new Map<string, QuotaReservation>();

  constructor(filePath: string, config: QuotaConfig) {
    this.filePath = filePath;
    this.config = config;
    this.data = this.load();
  }

  private load(): PersistedStore {
    const today = getTodayStr();
    const empty: PersistedStore = {
      users: Object.create(null) as Record<string, UserQuotaRecord>,
      codes: Object.create(null) as Record<string, RedeemCodeRecord>,
      globalDailyFree: { date: today, usedPages: 0 },
      ipDailyFree: { date: today, byIp: Object.create(null) as Record<string, number> },
    };

    try {
      if (!fs.existsSync(this.filePath)) {
        return empty;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedStore>;

      const users = Object.create(null) as Record<string, UserQuotaRecord>;
      if (parsed.users && typeof parsed.users === 'object') {
        for (const [k, v] of Object.entries(parsed.users)) {
          if (!FORBIDDEN_KEYS.has(k)) users[k] = v;
        }
      }

      const codes = Object.create(null) as Record<string, RedeemCodeRecord>;
      if (parsed.codes && typeof parsed.codes === 'object') {
        for (const [k, v] of Object.entries(parsed.codes)) {
          if (!FORBIDDEN_KEYS.has(k)) codes[k] = v;
        }
      }

      const byIp = Object.create(null) as Record<string, number>;
      if (parsed.ipDailyFree?.byIp && typeof parsed.ipDailyFree.byIp === 'object') {
        for (const [k, v] of Object.entries(parsed.ipDailyFree.byIp)) {
          if (!FORBIDDEN_KEYS.has(k) && typeof v === 'number') byIp[k] = v;
        }
      }

      return {
        users,
        codes,
        globalDailyFree: parsed.globalDailyFree || { date: today, usedPages: 0 },
        ipDailyFree: {
          date: parsed.ipDailyFree?.date || today,
          byIp,
        },
      };
    } catch (err) {
      console.warn('[quota-store] failed to read store, initializing fresh store:', err);
      return empty;
    }
  }

  /** Atomic write via temp file + rename to prevent JSON corruption on crash */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[quota-store] failed to persist store:', err);
    }
  }

  private syncGlobalDates(): void {
    const today = getTodayStr();
    if (this.data.globalDailyFree.date !== today) {
      this.data.globalDailyFree = { date: today, usedPages: 0 };
    }
    if (this.data.ipDailyFree.date !== today) {
      this.data.ipDailyFree = {
        date: today,
        byIp: Object.create(null) as Record<string, number>,
      };
    }
    // Evict stale reservations older than 5 minutes (defensive guard)
    const now = Date.now();
    for (const [id, r] of this.pendingReservations.entries()) {
      if (now - r.createdAt > 5 * 60 * 1000) {
        this.pendingReservations.delete(id);
      }
    }
  }

  private getVirtualUser(userId: string, tenantKey?: string): UserQuotaRecord {
    const cleanId = sanitizeKey(userId);
    const today = getTodayStr();
    this.syncGlobalDates();

    if (Object.hasOwn(this.data.users, cleanId)) {
      const existing = this.data.users[cleanId];
      if (existing.dailyDate !== today) {
        existing.dailyDate = today;
        existing.dailyUsed = 0;
      }
      return existing;
    }

    // Read-only virtual record (NOT persisted until actual consumption or valid redemption)
    return {
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
  }

  private ensurePersistedUser(userId: string, tenantKey?: string): UserQuotaRecord {
    const cleanId = sanitizeKey(userId);
    const user = this.getVirtualUser(cleanId, tenantKey);
    if (!Object.hasOwn(this.data.users, cleanId)) {
      this.data.users[cleanId] = user;
    } else if (tenantKey && !user.tenantKey) {
      user.tenantKey = tenantKey;
    }
    return user;
  }

  private getPendingTotals(userId: string, clientIp?: string): {
    userPaid: number;
    userDaily: number;
    userWelcome: number;
    globalFree: number;
    ipFree: number;
  } {
    let userPaid = 0;
    let userDaily = 0;
    let userWelcome = 0;
    let globalFree = 0;
    let ipFree = 0;
    const cleanIp = clientIp ? sanitizeKey(clientIp, 'ip') : undefined;

    for (const r of this.pendingReservations.values()) {
      if (r.userId === userId) {
        userPaid += r.plan.usePaid;
        userDaily += r.plan.useDaily;
        userWelcome += r.plan.useWelcome;
      }
      globalFree += r.plan.freeUsed;
      if (cleanIp && r.clientIp === cleanIp) {
        ipFree += r.plan.freeUsed;
      }
    }

    return { userPaid, userDaily, userWelcome, globalFree, ipFree };
  }

  /** Sliding-window IP rate limiter with automatic stale bucket eviction */
  checkIpRateLimit(
    ip: string,
    bucketPrefix: string,
    maxRequestsPerMinute = 10
  ): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const key = `${bucketPrefix}:${sanitizeKey(ip, 'ip')}`;

    // Periodic cleanup when map grows
    if (this.ipBuckets.size > 500) {
      for (const [k, list] of this.ipBuckets.entries()) {
        const fresh = list.filter((ts) => now - ts < windowMs);
        if (fresh.length === 0) this.ipBuckets.delete(k);
        else this.ipBuckets.set(k, fresh);
      }
    }

    const prev = (this.ipBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
    if (prev.length >= maxRequestsPerMinute) {
      const oldest = prev[0];
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      this.ipBuckets.set(key, prev);
      return { allowed: false, retryAfterSec };
    }
    prev.push(now);
    this.ipBuckets.set(key, prev);
    return { allowed: true };
  }

  /** Strictly read-only snapshot (never writes to disk on GET /api/quota) */
  getSnapshot(userId: string, tenantKey?: string): QuotaSnapshot {
    const cleanId = sanitizeKey(userId);
    const user = this.getVirtualUser(cleanId, tenantKey);
    const pending = this.getPendingTotals(cleanId);

    const dailyRemaining = Math.max(0, this.config.freeDailyPages - user.dailyUsed - pending.userDaily);
    const welcomeRemaining = Math.max(0, user.welcomeRemaining - pending.userWelcome);
    const paidRemaining = Math.max(0, user.paidRemaining - pending.userPaid);
    const globalFreeRemainingToday = Math.max(
      0,
      this.config.globalDailyFreeLimit - this.data.globalDailyFree.usedPages - pending.globalFree
    );
    const isPro = paidRemaining > 0;
    const totalAvailable = dailyRemaining + welcomeRemaining + paidRemaining;

    return {
      userId: user.userId,
      tier: isPro ? 'pro' : 'free',
      dailyRemaining,
      dailyLimit: this.config.freeDailyPages,
      welcomeRemaining,
      paidRemaining,
      totalAvailable,
      maxFilesPerRequest: isPro ? this.config.proMaxFiles : this.config.freeMaxFiles,
      maxPdfPages: isPro ? this.config.proMaxPdfPages : this.config.freeMaxPdfPages,
      globalFreeRemainingToday,
    };
  }

  /**
   * Atomically reserves pages before invoking LLM (eliminates TOCTOU concurrent bypass).
   * Deduction rules are unified between check & commit:
   * - Pro users (paidRemaining > 0) consume paid pages FIRST (routed to LLM_PRO_MODEL,
   *   never eating into shared office IP or global free circuit breakers, and preventing
   *   the "1 paid page = permanent free Pro" exploit).
   * - Free users consume daily -> welcome (subject to per-IP & global daily free caps).
   */
  reserve(
    userId: string,
    pageCount: number,
    tenantKey?: string,
    clientIp?: string
  ):
    | { allowed: true; reservation: QuotaReservation; snapshot: QuotaSnapshot }
    | { allowed: false; statusCode: number; error: string; snapshot: QuotaSnapshot } {
    const cleanId = sanitizeKey(userId);
    const cleanIp = clientIp ? sanitizeKey(clientIp, 'ip') : undefined;
    const snapshot = this.getSnapshot(cleanId, tenantKey);

    if (!Number.isInteger(pageCount) || pageCount <= 0) {
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

    // Unified deduction plan: paid first (when Pro) -> daily -> welcome
    let left = pageCount;
    const usePaid = Math.min(left, snapshot.paidRemaining);
    left -= usePaid;

    const useDaily = Math.min(left, snapshot.dailyRemaining);
    left -= useDaily;

    const useWelcome = Math.min(left, snapshot.welcomeRemaining);
    left -= useWelcome;

    const freeUsed = useDaily + useWelcome;
    const pending = this.getPendingTotals(cleanId, cleanIp);

    if (freeUsed > 0) {
      if (cleanIp) {
        const ipUsed =
          (Object.hasOwn(this.data.ipDailyFree.byIp, cleanIp)
            ? this.data.ipDailyFree.byIp[cleanIp]
            : 0) + pending.ipFree;
        if (ipUsed + freeUsed > this.config.ipDailyFreeLimit) {
          return {
            allowed: false,
            statusCode: 429,
            error: `当前网络环境今日免费额度已达上限（单 IP 每日最多 ${this.config.ipDailyFreeLimit} 页），请明日再试，或兑换 Pro 激活码（付费额度不受 IP 限制）。`,
            snapshot,
          };
        }
      }
      if (snapshot.globalFreeRemainingToday < freeUsed) {
        return {
          allowed: false,
          statusCode: 429,
          error: '今日全站免费通道额度已达保护上限，请明日再试，或兑换 Pro 激活码走专属高速通道（不受限）。',
          snapshot,
        };
      }
    }

    const reservation: QuotaReservation = {
      id: crypto.randomUUID(),
      userId: cleanId,
      tenantKey,
      clientIp: cleanIp,
      pageCount,
      plan: {
        usePaid,
        useDaily,
        useWelcome,
        freeUsed,
        useProModel: usePaid > 0,
      },
      createdAt: Date.now(),
    };

    this.pendingReservations.set(reservation.id, reservation);

    return {
      allowed: true,
      reservation,
      snapshot: this.getSnapshot(cleanId, tenantKey),
    };
  }

  /** Commits a reservation after LLM extraction succeeds */
  commit(reservationId: string): QuotaSnapshot {
    const r = this.pendingReservations.get(reservationId);
    if (!r) {
      throw new Error('Quota reservation not found or already settled');
    }
    this.pendingReservations.delete(reservationId);

    const user = this.ensurePersistedUser(r.userId, r.tenantKey);
    user.paidRemaining = Math.max(0, user.paidRemaining - r.plan.usePaid);
    user.dailyUsed += r.plan.useDaily;
    user.welcomeRemaining = Math.max(0, user.welcomeRemaining - r.plan.useWelcome);

    if (r.plan.freeUsed > 0) {
      this.data.globalDailyFree.usedPages += r.plan.freeUsed;
      if (r.clientIp) {
        const cur = Object.hasOwn(this.data.ipDailyFree.byIp, r.clientIp)
          ? this.data.ipDailyFree.byIp[r.clientIp]
          : 0;
        this.data.ipDailyFree.byIp[r.clientIp] = cur + r.plan.freeUsed;
      }
    }

    user.totalUsedPages += r.pageCount;
    user.lastActiveAt = new Date().toISOString();
    this.save();

    return this.getSnapshot(r.userId, r.tenantKey);
  }

  /** Releases a reservation if extraction fails (failed calls never burn credits) */
  release(reservationId: string): void {
    this.pendingReservations.delete(reservationId);
  }

  generateCodes(count: number, pages: number, note?: string): RedeemCodeRecord[] {
    if (!Number.isFinite(count) || !Number.isFinite(pages)) {
      throw new Error('count 和 pages 必须为有效数字');
    }
    const safeCount = Math.min(Math.max(1, Math.floor(count)), 200);
    const safePages = Math.min(Math.max(1, Math.floor(pages)), 100000);
    const created: RedeemCodeRecord[] = [];

    for (let i = 0; i < safeCount; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `ATS-${part1}-${part2}`;
      const record: RedeemCodeRecord = {
        code,
        pages: safePages,
        note: typeof note === 'string' ? note.slice(0, 100) : undefined,
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
    rawCode: unknown,
    tenantKey?: string
  ): { ok: true; addedPages: number; snapshot: QuotaSnapshot } | { ok: false; error: string } {
    if (typeof rawCode !== 'string' || !rawCode.trim()) {
      return { ok: false, error: '请输入有效的字符串激活码' };
    }
    const code = rawCode.trim().toUpperCase();
    const cleanId = sanitizeKey(userId);

    // Built-in demo code for local testing ONLY when LLM_API_KEY is not configured
    if (this.config.isMockMode && code === 'ATS-DEMO-100') {
      const user = this.ensurePersistedUser(cleanId, tenantKey);
      user.paidRemaining += 100;
      user.lastActiveAt = new Date().toISOString();
      this.save();
      return { ok: true, addedPages: 100, snapshot: this.getSnapshot(cleanId, tenantKey) };
    }

    if (FORBIDDEN_KEYS.has(code) || !Object.hasOwn(this.data.codes, code)) {
      return { ok: false, error: '激活码无效，请检查拼写是否正确' };
    }

    const record = this.data.codes[code];
    if (record.redeemedBy) {
      return { ok: false, error: '该激活码已被使用，无法重复兑换' };
    }

    const user = this.ensurePersistedUser(cleanId, tenantKey);
    record.redeemedBy = user.userId;
    record.redeemedAt = new Date().toISOString();
    user.paidRemaining += record.pages;
    user.lastActiveAt = new Date().toISOString();
    this.save();

    return {
      ok: true,
      addedPages: record.pages,
      snapshot: this.getSnapshot(cleanId, tenantKey),
    };
  }
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../database/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError, registerSecrets } from '../logging/sanitize.js';
import type { ContentCipher } from '../security/crypto.js';
import { escapeHtml } from '../telegram/common/html.js';
import { currentTenant, currentTenantId, currentTenantOrNull } from '../tenancy/context.js';
import type { TenantService } from '../tenancy/tenant.service.js';
import { formatDateTime, formatTime } from '../utils/time.js';

const log = childLogger('google-calendar');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
/** The OAuth `state` (signed workspace id) is valid this long. */
const STATE_TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 20_000;
export const REMIND_BEFORE_MS = 30 * 60_000;
const MAX_REMINDED = 100;

export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

export interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  htmlLink?: string;
}

export interface NewEvent {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
}

export interface CalendarDeps {
  db: Db;
  cipher: ContentCipher;
  tenants: TenantService;
  notifier: { text(html: string): Promise<number | undefined> };
  clientId?: string;
  clientSecret?: string;
  /** Public base URL of the service (https://…); the callback path is appended. */
  publicUrl?: string;
  /** Secret for signing the OAuth state. */
  stateSecret: string;
  /** Only this owner may connect a calendar for now. */
  superAdminId: bigint;
  timezone: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class CalendarError extends Error {}

interface GoogleEventResource {
  id?: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/**
 * Google Calendar of the workspace owner (OAuth "web server" flow). For now only the super-admin can
 * connect; tokens are stored encrypted in the tenant-scoped `google_accounts` table.
 */
export class CalendarService {
  constructor(private readonly d: CalendarDeps) {
    registerSecrets([d.clientSecret]);
  }

  private get fetch(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  configured(): boolean {
    return !!(this.d.clientId && this.d.clientSecret && this.d.publicUrl);
  }

  /** Calendar is offered only to the super-admin's workspace for now. */
  allowed(): boolean {
    return currentTenantOrNull()?.ownerTelegramUserId === this.d.superAdminId;
  }

  private redirectUri(): string {
    return `${(this.d.publicUrl ?? '').replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}`;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────

  /** `<tenantId>.<expiresAt>.<nonce>.<hmac>`: binds the callback to the workspace that asked for it. */
  signState(tenantId: number): string {
    const payload = `${tenantId}.${this.now().getTime() + STATE_TTL_MS}.${randomBytes(8).toString('hex')}`;
    return `${payload}.${createHmac('sha256', this.d.stateSecret).update(payload).digest('hex')}`;
  }

  verifyState(state: string): number | null {
    const parts = state.split('.');
    if (parts.length !== 4) return null;
    const [tenantId, expires, nonce, mac] = parts as [string, string, string, string];
    const expected = createHmac('sha256', this.d.stateSecret).update(`${tenantId}.${expires}.${nonce}`).digest('hex');
    const a = Buffer.from(mac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (!/^\d+$/.test(tenantId) || !/^\d+$/.test(expires) || Number(expires) < this.now().getTime()) return null;
    return Number(tenantId);
  }

  /** The consent link for the current workspace owner. */
  connectUrl(): string {
    const params = new URLSearchParams({
      client_id: this.d.clientId ?? '',
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: this.signState(currentTenantId('calendar')),
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** GET /oauth/google/callback — exchanges the code and stores the tokens (returns an HTML page). */
  async handleCallback(url: URL): Promise<{ status: number; html: string }> {
    const page = (title: string, text: string) =>
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${title}</h2><p>${text}</p></body>`;
    const tenantId = this.verifyState(url.searchParams.get('state') ?? '');
    if (tenantId === null) return { status: 400, html: page('⚠️ Havola eskirgan', 'Botga qaytib, «kalendarni ula» deb qayta yozing.') };
    if (url.searchParams.get('error')) return { status: 200, html: page('❎ Bekor qilindi', 'Ruxsat berilmadi. Botga qaytishingiz mumkin.') };
    const code = url.searchParams.get('code');
    if (!code) return { status: 400, html: page('⚠️ Xato', 'Google kod qaytarmadi.') };
    const tenant = await this.d.tenants.byId(tenantId);
    if (!tenant || tenant.status !== 'ACTIVE' || tenant.telegramUserId !== this.d.superAdminId)
      return { status: 403, html: page('⛔ Ruxsat yo‘q', 'Kalendar hozircha faqat administrator uchun.') };
    try {
      const tokens = await this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri() });
      if (!tokens.refresh_token) throw new CalendarError('Google refresh token qaytarmadi');
      const email = emailFromIdToken(tokens.id_token);
      await this.d.tenants.run(tenant, async () => {
        const data = {
          email,
          refreshToken: this.d.cipher.encrypt(tokens.refresh_token!),
          accessToken: this.d.cipher.encrypt(tokens.access_token),
          expiresAt: new Date(this.now().getTime() + (tokens.expires_in - 60) * 1000),
        };
        await this.d.db.googleAccount.upsert({ where: { tenantId: currentTenantId() }, create: data, update: data });
        await this.d.notifier.text(
          `✅ Google Calendar ulandi${email ? `: <b>${escapeHtml(email)}</b>` : ''}\n\nEndi yozing: <i>Bugun nima rejalarim bor?</i> yoki <i>Ertaga 15:00 ga Ali bilan uchrashuv qo‘sh</i>.`,
        );
      });
      return { status: 200, html: page('✅ Kalendar ulandi', 'Telegram’ga qaytishingiz mumkin.') };
    } catch (error) {
      log.warn({ error: describeError(error) }, 'google oauth callback failed');
      return { status: 500, html: page('❌ Ulab bo‘lmadi', 'Qaytadan urinib ko‘ring.') };
    }
  }

  private async token(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }> {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.d.clientId ?? '', client_secret: this.d.clientSecret ?? '', ...body }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string; error?: string };
    if (!res.ok || !json.access_token) throw new CalendarError(`token request failed (${res.status} ${json.error ?? ''})`);
    registerSecrets([json.access_token, json.refresh_token]);
    return { access_token: json.access_token, expires_in: json.expires_in ?? 3600, ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}), ...(json.id_token ? { id_token: json.id_token } : {}) };
  }

  // ── account ────────────────────────────────────────────────────────────

  async account() {
    return this.d.db.googleAccount.findUnique({ where: { tenantId: currentTenantId('calendar') } });
  }

  async disconnect(): Promise<boolean> {
    const acc = await this.account();
    if (!acc) return false;
    const refresh = this.d.cipher.decrypt(acc.refreshToken);
    if (refresh) await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
    await this.d.db.googleAccount.deleteMany({ where: { tenantId: currentTenantId('calendar') } });
    return true;
  }

  private async accessToken(): Promise<string> {
    const acc = await this.account();
    if (!acc) throw new CalendarError('not connected');
    const cached = this.d.cipher.decrypt(acc.accessToken);
    if (cached && acc.expiresAt && acc.expiresAt.getTime() > this.now().getTime()) return cached;
    const refresh = this.d.cipher.decrypt(acc.refreshToken);
    if (!refresh) throw new CalendarError('refresh token unreadable');
    const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: refresh });
    await this.d.db.googleAccount.update({
      where: { tenantId: currentTenantId() },
      data: { accessToken: this.d.cipher.encrypt(tokens.access_token), expiresAt: new Date(this.now().getTime() + (tokens.expires_in - 60) * 1000) },
    });
    return tokens.access_token;
  }

  private async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new CalendarError(`calendar API ${res.status}`);
    return (await res.json()) as T;
  }

  // ── events ─────────────────────────────────────────────────────────────

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const res = await this.api<{ items?: GoogleEventResource[] }>(`/calendars/primary/events?${q.toString()}`);
    return (res.items ?? []).map(toEvent).filter((e): e is CalendarEvent => e !== null);
  }

  async createEvent(e: NewEvent): Promise<CalendarEvent> {
    const created = await this.api<GoogleEventResource>('/calendars/primary/events', {
      method: 'POST',
      body: {
        summary: e.summary,
        ...(e.description ? { description: e.description } : {}),
        start: { dateTime: e.start.toISOString(), timeZone: this.d.timezone },
        end: { dateTime: e.end.toISOString(), timeZone: this.d.timezone },
      },
    });
    const event = toEvent(created);
    if (!event) throw new CalendarError('calendar returned an invalid event');
    return event;
  }

  /** "Today: …" style list for the admin chat. */
  formatEvents(events: CalendarEvent[], title: string): string {
    if (events.length === 0) return `📅 <b>${escapeHtml(title)}</b>\n\nRejalar yo‘q — bo‘shsiz.`;
    const lines = [`📅 <b>${escapeHtml(title)}</b>`, ''];
    for (const e of events) {
      const when = e.allDay ? 'kun bo‘yi' : `${formatDateTime(e.start, this.d.timezone)}–${formatTime(e.end, this.d.timezone)}`;
      lines.push(`• ${when} — ${escapeHtml(e.summary)}`);
    }
    return lines.join('\n');
  }

  /** Scheduler tick (super-admin scope): reminds once about events starting within 30 minutes. */
  async remindUpcoming(): Promise<void> {
    if (!this.configured() || !this.allowed()) return;
    const acc = await this.account();
    if (!acc) return;
    let events: CalendarEvent[];
    try {
      const now = this.now();
      events = await this.listEvents(now, new Date(now.getTime() + REMIND_BEFORE_MS));
    } catch (error) {
      log.warn({ error: describeError(error) }, 'calendar reminder check failed');
      return;
    }
    const fresh = events.filter((e) => !e.allDay && !acc.remindedEventIds.includes(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) {
      const minutes = Math.max(0, Math.round((e.start.getTime() - this.now().getTime()) / 60_000));
      await this.d.notifier.text(`⏰ <b>${minutes} daqiqadan keyin:</b> ${escapeHtml(e.summary)} (${formatTime(e.start, this.d.timezone)})`);
    }
    await this.d.db.googleAccount.update({
      where: { tenantId: currentTenant().tenantId },
      data: { remindedEventIds: [...acc.remindedEventIds, ...fresh.map((e) => e.id)].slice(-MAX_REMINDED) },
    });
  }
}

function toEvent(r: GoogleEventResource): CalendarEvent | null {
  const startRaw = r.start?.dateTime ?? r.start?.date;
  const endRaw = r.end?.dateTime ?? r.end?.date;
  if (!r.id || !startRaw || !endRaw) return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { id: r.id, summary: r.summary?.trim() || '(nomsiz)', start, end, allDay: !r.start?.dateTime, ...(r.htmlLink ? { htmlLink: r.htmlLink } : {}) };
}

/** The `email` claim of the id_token (received directly from Google's token endpoint over TLS). */
function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email.slice(0, 200) : null;
  } catch {
    return null;
  }
}

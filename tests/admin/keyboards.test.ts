import { describe, expect, it } from 'vitest';
import type { MessageDetail } from '../../src/messages/history.service.js';
import type { PeriodStats } from '../../src/statistics/stats.service.js';
import { parseCb } from '../../src/telegram/admin/callback-data.js';
import type { AdminDeps } from '../../src/telegram/admin/deps.js';
import { FIELDS } from '../../src/telegram/admin/fields.js';
import { createAdminKit } from '../../src/telegram/admin/index.js';
import { callbackData, paginate, type View } from '../../src/telegram/admin/ui.js';
import * as adv from '../../src/telegram/admin/views/advanced.js';
import { buildAttentionItem, buildAttentionList } from '../../src/telegram/admin/views/attention.js';
import { buildAutoReply } from '../../src/telegram/admin/views/auto-reply.js';
import { buildHistoryList } from '../../src/telegram/admin/views/history.js';
import { buildList } from '../../src/telegram/admin/views/lists.js';
import { buildLogs } from '../../src/telegram/admin/views/logs.js';
import { buildHelp, buildMainMenu, buildStatus } from '../../src/telegram/admin/views/main.js';
import { buildCleanupConfirm, buildCleanupReport, buildConnections } from '../../src/telegram/admin/views/maintenance.js';
import * as media from '../../src/telegram/admin/views/media.js';
import { buildMessageDetail, buildMessageVersions } from '../../src/telegram/admin/views/message-detail.js';
import { TARGETS, buildModelOverview, buildModelPicker, buildTargetView, type TargetCode } from '../../src/telegram/admin/views/models.js';
import { buildPersonal } from '../../src/telegram/admin/views/personal.js';
import {
  buildDeleteChatConfirm,
  buildDeleteUserConfirm,
  buildDeleted,
  buildPrivacy,
} from '../../src/telegram/admin/views/privacy.js';
import { buildPromptMenu, buildPromptVersions, buildPromptView, buildResetConfirm } from '../../src/telegram/admin/views/prompt.js';
import { buildReplyRules, buildTagModePicker, buildTagRules } from '../../src/telegram/admin/views/rules.js';
import { buildStats } from '../../src/telegram/admin/views/stats.js';
import { buildLength, buildReasoning, buildStyle } from '../../src/telegram/admin/views/style.js';
import { buildSearchResults, buildUserList, buildUserPage } from '../../src/telegram/admin/views/users.js';
import { fakeAdminStateTable, testSettings } from './helpers.js';

const TZ = 'Asia/Tashkent';
const NOW = new Date('2026-10-04T10:00:00Z');
const BIG_USER = 9_007_199_254_740_993n; // longer than any real Telegram id
const BIG_INT = 2_147_483_647;
const LONG = '😀<&>'.repeat(2000);

const s = testSettings({ responseDelayMode: 'CUSTOM', pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() });
const off = testSettings({ autoReplyEnabled: false });
const providers = [
  { id: 'gemini' as const, displayName: 'Google Gemini' },
  { id: 'openai_compat' as const, displayName: 'OpenAI-compatible' },
];
const user = {
  telegramUserId: BIG_USER,
  username: 'a'.repeat(32),
  firstName: 'Ali <b>',
  lastName: 'Valiyev',
  messageCount: 157,
  lastMessageAt: new Date(NOW.getTime() - 2 * 3_600_000),
  tags: ['friends', 'x'.repeat(32)],
};
const midPage = paginate(500, 7, 8);
const period: PeriodStats = {
  messages: 12345,
  aiReplies: 1000,
  manual: 12,
  personal: 3,
  ownerQueuePending: 4,
  imagesAnalyzed: 1,
  voiceAnalyzed: 2,
  videosAnalyzed: 3,
  videoNotesAnalyzed: 4,
  documentsAnalyzed: 5,
  edited: 6,
  deleted: 7,
  errors: 8,
  avgAiLatencyMs: 1432,
  inputTokens: 1_234_567,
  outputTokens: 456_789,
  estimatedCostUsd: 1.2345,
};
const attention = {
  id: BIG_INT,
  status: 'PENDING' as const,
  reason: 'PERSONAL',
  detail: LONG,
  createdAt: NOW,
  messageId: BIG_INT,
  text: LONG,
  userLabel: '@' + 'a'.repeat(32),
  senderTelegramUserId: BIG_USER,
};
const detail: MessageDetail = {
  id: BIG_INT,
  chatId: BIG_INT,
  telegramChatId: BIG_USER,
  telegramMessageId: 1,
  direction: 'INCOMING',
  type: 'PHOTO',
  status: 'ANSWERED',
  statusReason: LONG,
  classification: 'PERSONAL',
  classificationConfidence: 0.87,
  classificationReason: LONG,
  injectionSuspected: true,
  telegramDate: NOW,
  editedAt: NOW,
  deletedAt: NOW,
  sender: { telegramUserId: BIG_USER, username: null, firstName: 'Ali', lastName: null },
  versions: Array.from({ length: 30 }, (_, i) => ({ version: i + 1, text: LONG, caption: LONG, editedAt: NOW, createdAt: NOW })),
  media: Array.from({ length: 10 }, () => ({
    kind: 'PHOTO',
    status: 'DONE',
    fileName: LONG,
    extractedText: LONG,
    description: LONG,
    error: LONG,
  })),
  responses: Array.from({ length: 10 }, () => ({
    kind: 'AUTO_REPLY',
    status: 'SENT',
    text: LONG,
    provider: 'openai_compat',
    model: 'm'.repeat(120),
    reasoningEffort: 'medium',
    inputTokens: 123456,
    outputTokens: 7890,
    costUsd: 0.0012,
    latencyMs: 1500,
    usedFallback: true,
    createdAt: NOW,
  })),
  attention: { id: BIG_INT, status: 'PENDING', reason: 'PERSONAL' },
};

function allViews(): Array<[string, View]> {
  const views: Array<[string, View]> = [
    ['main', buildMainMenu({ settings: s, pending: 12, costToday: 1.5, now: NOW, timezone: TZ })],
    ['main-off', buildMainMenu({ settings: off, pending: 0, costToday: 0, now: NOW, timezone: TZ })],
    ['status', buildStatus({ settings: s, pending: 1, costToday: 0, now: NOW, timezone: TZ, connection: { isEnabled: true, canReply: false } })],
    ['help', buildHelp('Komron')],
    ['auto-reply', buildAutoReply({ settings: s, now: NOW, timezone: TZ })],
    ['auto-reply-off', buildAutoReply({ settings: off, now: NOW, timezone: TZ })],
    ['reply-rules', buildReplyRules(s)],
    ['tag-rules', buildTagRules(Array.from({ length: 8 }, (_, i) => ({ id: BIG_INT - i, matchValue: 't'.repeat(32), mode: 'MANUAL' as const })), midPage)],
    ['tag-mode', buildTagModePicker()],
    ['users', buildUserList(Array.from({ length: 8 }, () => ({ user, mode: 'VIP' as const })), midPage)],
    ['search', buildSearchResults(LONG, [{ user, mode: null }])],
    ['user', buildUserPage({ user, mode: 'BLOCK' }, NOW)],
    ['models', buildModelOverview(s, providers)],
    [
      'model-picker',
      buildModelPicker(
        'tts',
        providers[1]!,
        Array.from({ length: 50 }, (_, i) => ({ id: `models/${'x'.repeat(100)}-${i}`, displayName: LONG })),
        3,
        null,
      ),
    ],
    ['model-picker-failed', buildModelPicker('main', providers[0]!, [], 0, null, true)],
    ['model-picker-default', buildModelPicker('tr', providers[1]!, [], 0, null, false, `models/${'w'.repeat(110)}`)],
    ['prompt', buildPromptMenu({ version: 999_999, content: LONG })],
    ['prompt-view', buildPromptView({ version: 999_999, content: LONG }, true)],
    ['prompt-old', buildPromptView({ version: 999_999, content: LONG }, false, NOW, TZ)],
    [
      'prompt-versions',
      buildPromptVersions(
        Array.from({ length: 6 }, (_, i) => ({ version: 999_999 - i, content: LONG, isActive: i === 0, createdAt: NOW })),
        midPage,
        TZ,
      ),
    ],
    ['prompt-reset', buildResetConfirm()],
    ['reasoning', buildReasoning(s)],
    ['style', buildStyle(testSettings({ customStylePrompt: LONG.slice(0, 2000) }))],
    ['length', buildLength(s)],
    ['personal', buildPersonal(testSettings({ personalReplyText: LONG.slice(0, 1000) }))],
    ['img', media.buildImage(s)],
    ['voice', media.buildVoice(s)],
    ['video', media.buildVideo(s)],
    ['video-note', media.buildVideoNote(s)],
    ['doc', media.buildDocument(s)],
    ['attention-list', buildAttentionList(Array.from({ length: 6 }, () => attention), midPage, NOW)],
    ['attention-item', buildAttentionItem(attention, NOW, TZ)],
    ['attention-done', buildAttentionItem({ ...attention, status: 'IGNORED' }, NOW, TZ)],
    [
      'history',
      buildHistoryList(
        Array.from({ length: 10 }, (_, i) => ({
          id: BIG_INT - i,
          createdAt: NOW,
          type: 'VIDEO_NOTE' as const,
          status: 'ANSWERED' as const,
          classification: 'PERSONAL' as const,
          preview: LONG.slice(0, 60),
          userLabel: '@' + 'a'.repeat(32),
          edited: true,
          deleted: true,
        })),
        paginate(100_000, 9_999, 10),
        { filter: 'personal', sender: BIG_USER },
        TZ,
        LONG,
      ),
    ],
    ['detail', buildMessageDetail(detail, 'h|personal|9999|9007199254740993', TZ)],
    ['versions', buildMessageVersions(detail, 3, TZ)],
    ['versions-last', buildMessageVersions(detail, 999, TZ)],
    ['stats', buildStats({ today: period, week: period, topUsers: Array.from({ length: 5 }, () => ({ ...user, messages: 99 })), byModel: Array.from({ length: 20 }, () => ({ provider: 'openai_compat', model: LONG.slice(0, 120), calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 1 })) })],
    ['adv', adv.buildAdvanced(testSettings({ fallbackReplyText: LONG.slice(0, 1000), ownerName: 'K'.repeat(64) }))],
    ['adv-delay', adv.buildDelay(s)],
    ['adv-context', adv.buildContext(s)],
    ['adv-limits', adv.buildLimits(s, 3.21)],
    ['adv-retention', adv.buildRetention(s)],
    ['adv-notify', adv.buildNotifications(s)],
    ['cleanup', buildCleanupConfirm(NOW.toISOString(), TZ)],
    [
      'cleanup-report',
      buildCleanupReport({
        messages: 1,
        orphanUsers: 2,
        usageRows: 3,
        events: 4,
        processedUpdates: 5,
        jobs: 6,
        adminStates: 7,
        mediaFiles: 8,
        tempFiles: 9,
        uncertainResponses: 10,
      }),
    ],
    ['connections', buildConnections([{ isEnabled: true, canReply: false, connectedAt: NOW, updatedAt: NOW }], TZ)],
    ['connections-none', buildConnections([], TZ)],
    [
      'logs',
      buildLogs(
        Array.from({ length: 15 }, () => ({ level: 'ERROR', source: 's'.repeat(64), message: LONG.slice(0, 1000), createdAt: NOW })),
        Array.from({ length: 10 }, () => ({ action: 'SETTING_CHANGED', target: LONG.slice(0, 200), createdAt: NOW })),
        99_999,
        TZ,
      ),
    ],
    [
      'privacy',
      buildPrivacy(
        {
          encryptionAtRest: false,
          messageRetentionDays: 90,
          mediaRetentionDays: 7,
          aiLogRetentionDays: 30,
          retainRawMedia: true,
          storedMessages: 1,
          storedUsers: 2,
          storedMediaFiles: 3,
          oldestMessageAt: NOW,
        },
        TZ,
      ),
    ],
    ['delete-user', buildDeleteUserConfirm(BIG_USER, { label: LONG.slice(0, 100), messageCount: 5 })],
    ['delete-unknown', buildDeleteUserConfirm(BIG_USER, null)],
    ['delete-chat', buildDeleteChatConfirm(BIG_INT, 12)],
    ['deleted', buildDeleted({ messages: 1, chats: 1 })],
  ];
  for (const list of ['a', 'b', 'i'] as const) {
    views.push([
      `list-${list}`,
      buildList(
        list,
        Array.from({ length: 8 }, (_, i) => ({ id: BIG_INT - i, matchType: i % 2 ? ('USER_ID' as const) : ('USERNAME' as const), matchValue: '9'.repeat(20) })),
        midPage,
        new Map([['9'.repeat(20), LONG.slice(0, 64)]]),
      ),
    ]);
  }
  for (const code of Object.keys(TARGETS) as TargetCode[]) {
    views.push([`target-${code}`, buildTargetView(code, testSettings({ fallbackProvider: 'openai_compat', fallbackModel: 'x'.repeat(120) }), providers)]);
  }
  return views;
}

describe('admin keyboards', () => {
  const kit = createAdminKit({ db: { adminState: fakeAdminStateTable() } } as unknown as AdminDeps);
  const routes = new Set(kit.router.routes());

  it('every callback_data fits in 64 bytes and points at a registered route', () => {
    let buttons = 0;
    for (const [name, view] of allViews()) {
      for (const data of callbackData(view.keyboard)) {
        buttons++;
        expect(Buffer.byteLength(data, 'utf8'), `${name}: ${data}`).toBeLessThanOrEqual(64);
        const { route, args } = parseCb(data);
        expect(routes.has(route), `${name}: unknown route ${route}`).toBe(true);
        if (route === 'sv' || route === 'ed') {
          expect(FIELDS[args[0] ?? ''], `${name}: unknown field ${data}`).toBeDefined();
          const screen = route === 'sv' ? args[2] : args[1];
          if (screen) expect(routes.has(screen), `${name}: unknown screen ${screen}`).toBe(true);
        }
      }
    }
    expect(buttons).toBeGreaterThan(300);
  });

  it('every view fits in one Telegram message', () => {
    for (const [name, view] of allViews()) {
      expect(view.text.length, name).toBeLessThanOrEqual(4000);
      expect(view.keyboard.inline_keyboard.every((row) => row.length > 0), `${name}: empty row`).toBe(true);
    }
  });

  it('escapes untrusted text', () => {
    const page = buildUserPage({ user, mode: null }, NOW);
    expect(page.text).toContain('Ali &lt;b&gt;');
    const item = buildAttentionItem({ ...attention, text: '<script>' }, NOW, TZ);
    expect(item.text).toContain('&lt;script&gt;');
    expect(item.text).not.toContain('<script>');
  });

  it('user page matches the required layout', () => {
    const page = buildUserPage({ user: { ...user, username: 'username' }, mode: 'AUTO' }, NOW);
    expect(page.text.startsWith('👤 @username\nMode: AUTO\nMessages: 157\nLast message: 2 soat oldin')).toBe(true);
    const labels = page.keyboard.inline_keyboard.flat().map((b) => b.text);
    for (const l of ['🤖 Auto', '👤 Manual', '🚫 Ignore', '⛔ Block', '⭐ VIP', '♻️ Reset to default', '🏷 Tags', '💬 History', '🗑 Delete data']) {
      expect(labels.some((x) => x.endsWith(l))).toBe(true);
    }
  });

  it('field codes are short and unique per setting key', () => {
    const keys = new Set<string>();
    for (const [code, def] of Object.entries(FIELDS)) {
      expect(code.length).toBeLessThanOrEqual(4);
      expect(keys.has(def.key), `duplicate key ${def.key}`).toBe(false);
      keys.add(def.key);
    }
  });

  it('message detail offers every version, paginated', () => {
    const view = buildMessageDetail(detail, 'h|all|0', TZ);
    expect(callbackData(view.keyboard)).toContain(`msg.v|${BIG_INT}|0`);
    const last = buildMessageVersions(detail, 999, TZ);
    expect(last.text).toContain('<b>v30</b>');
    expect(callbackData(last.keyboard)).toContain(`msg.v|${BIG_INT}|6`);
    expect(callbackData(last.keyboard)).toContain(`msg.o|${BIG_INT}|all|0`);
  });

  it('transcription/TTS pickers offer the provider default model first', () => {
    const view = buildModelPicker('tts', providers[0]!, [{ id: 'gemini-x', displayName: 'X' }], 0, null, false, 'gemini-tts');
    const first = view.keyboard.inline_keyboard[0]?.[0];
    expect(first?.text).toContain('Standart: gemini-tts');
    expect(first && 'callback_data' in first ? first.callback_data : '').toBe('ai.d|tts|gemini');
  });

  it('every ROUTES entry used by notifications is handled', () => {
    for (const r of ['oa.r', 'oa.ai', 'oa.ig', 'oa.mn', 'oa.o', 'msg.o', 'm']) expect(routes.has(r), r).toBe(true);
  });
});

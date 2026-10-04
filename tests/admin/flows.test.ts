import { describe, expect, it, vi } from 'vitest';
import { PromptValidationError } from '../../src/conversations/prompt.service.js';
import { buildAutoReply } from '../../src/telegram/admin/views/auto-reply.js';
import { callbackData } from '../../src/telegram/admin/ui.js';
import {
  ADMIN_ID,
  baseDeps,
  callbackUpdate,
  callsOf,
  createTestBot,
  messageUpdate,
  photoUpdate,
  sentTexts,
  testSettings,
} from './helpers.js';

function attentionItem(id: number, status = 'PENDING') {
  return {
    id,
    status,
    reason: 'PERSONAL',
    detail: null,
    createdAt: new Date(),
    resolvedAt: null,
    messageId: 900 + id,
    chatId: 1,
    telegramChatId: 555n,
    connectionId: 'bc',
    telegramMessageId: 1,
    text: 'Qayerdasan? <b>',
    userLabel: '@ali',
    senderTelegramUserId: 555n,
    adminNotificationMessageId: null,
  };
}

describe('admin main menu', () => {
  it('/start shows the main menu to the admin', async () => {
    const { deps } = baseDeps();
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/start'));
    const sent = callsOf(calls, 'sendMessage');
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.payload.text);
    expect(text).toContain('🤖 <b>AUTO RESPONDER</b>');
    expect(text).toContain('Status: 🟢 ON');
    expect(text).toContain('🔔 Owner queue: 3');
    expect(text).toContain('💸 Today: $0.42 /');
    expect(sent[0]?.payload.parse_mode).toBe('HTML');
    const markup = sent[0]?.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    const labels = markup.inline_keyboard.flat().map((b) => b.text);
    for (const l of ['👥 Reply Rules', '🧠 AI Model', '📝 System Prompt', '🔐 Privacy', '📜 Logs', '🗑 Deleted Messages']) {
      expect(labels).toContain(l);
    }
  });

  it('shows the pause state in the status line', async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const { deps } = baseDeps(testSettings({ pausedUntil: until }));
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/menu'));
    expect(sentTexts(calls)).toMatch(/Status: 🟡 PAUSED until \d\d:\d\d/);
  });
});

describe('auto reply toggle', () => {
  it('the Turn OFF button calls settings.set(autoReplyEnabled, false, adminId) and edits in place', async () => {
    const { deps } = baseDeps();
    const view = buildAutoReply({ settings: testSettings({ autoReplyEnabled: true }), now: new Date(), timezone: 'UTC' });
    const offData = callbackData(view.keyboard).find((d) => d.startsWith('sv|ae|'));
    expect(offData).toBe('sv|ae|0');

    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, offData ?? ''));
    expect(deps.settings.set).toHaveBeenCalledWith('autoReplyEnabled', false, ADMIN_ID);
    expect(callsOf(calls, 'editMessageText')).toHaveLength(1);
    expect(String(callsOf(calls, 'editMessageText')[0]?.payload.text)).toContain('DISABLED');
    const answers = callsOf(calls, 'answerCallbackQuery');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.payload.text).toBe('✅ Saqlandi');
  });

  it('pause 1 hour stores an ISO timestamp ~60 minutes ahead', async () => {
    const { deps } = baseDeps();
    const { bot } = createTestBot(deps);
    const before = Date.now();
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'ar.p|60'));
    const call = deps.settings.set.mock.calls.find((c) => c[0] === 'pausedUntil');
    const until = new Date(String(call?.[1])).getTime();
    expect(until - before).toBeGreaterThanOrEqual(59 * 60_000);
    expect(until - before).toBeLessThanOrEqual(61 * 60_000);
    expect(call?.[2]).toBe(ADMIN_ID);
  });

  it('a validation error is shown as an alert, not a crash', async () => {
    const { deps } = baseDeps();
    const { SettingValidationError } = await import('../../src/settings/settings.service.js');
    deps.settings.set.mockRejectedValueOnce(new SettingValidationError('maxFrames', 'Too big'));
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'sv|mf|99'));
    const answer = callsOf(calls, 'answerCallbackQuery')[0];
    expect(answer?.payload.show_alert).toBe(true);
    expect(String(answer?.payload.text)).toContain('Too big');
  });
});

describe('owner attention', () => {
  it('🚫 Ignore resolves the item as IGNORED', async () => {
    const { deps } = baseDeps();
    const resolve = vi.fn(async () => true);
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, resolve } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.ig|5'));
    expect(resolve).toHaveBeenCalledWith(5, 'IGNORED', ADMIN_ID);
    expect(callsOf(calls, 'answerCallbackQuery')[0]?.payload.text).toContain('E’tiborsiz');
  });

  it('handles an already-resolved item gracefully', async () => {
    const { deps } = baseDeps();
    const resolve = vi.fn(async () => false);
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, resolve } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.ig|5'));
    const answer = callsOf(calls, 'answerCallbackQuery')[0];
    expect(String(answer?.payload.text)).toContain('allaqachon hal qilingan');
  });

  it('🤖 Let AI reply enqueues the job with the dedupe key (never runs it inline)', async () => {
    const { deps } = baseDeps();
    const enqueue = vi.fn(async () => 1);
    const ownerApprovedAiReply = vi.fn();
    const get = vi.fn(async (id: number) => attentionItem(id));
    const { bot, calls } = createTestBot({
      ...deps,
      attention: { ...deps.attention, get },
      queue: { enqueue },
      pipeline: { ownerApprovedAiReply },
    });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.ai|7'));
    expect(enqueue).toHaveBeenCalledWith(
      'text',
      'attention.ai',
      { attentionId: 7, adminId: ADMIN_ID.toString() },
      { dedupeKey: 'attention-ai:7' },
    );
    expect(ownerApprovedAiReply).not.toHaveBeenCalled();
    expect(callsOf(calls, 'answerCallbackQuery')[0]?.payload.text).toBe('🤖 AI javob tayyorlayapti…');
  });

  it('👤 Always manual sets MANUAL mode for the sender and resolves the item', async () => {
    const { deps } = baseDeps();
    const resolve = vi.fn(async () => true);
    const setMode = vi.fn(async () => undefined);
    const get = vi.fn(async (id: number) => attentionItem(id));
    const { bot } = createTestBot({ ...deps, attention: { ...deps.attention, get, resolve }, users: { setMode } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.mn|9'));
    expect(setMode).toHaveBeenCalledWith(555n, 'MANUAL', ADMIN_ID);
    expect(resolve).toHaveBeenCalledWith(9, 'IGNORED', ADMIN_ID);
  });

  it('💬 Reply: the next text message is sent through ownerManualReply', async () => {
    const { deps } = baseDeps();
    const get = vi.fn(async (id: number) => attentionItem(id));
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.r|3'));
    // From a notification the prompt is a new message (the notification stays intact).
    expect(callsOf(calls, 'sendMessage')).toHaveLength(1);
    expect(sentTexts(calls)).toContain('Qayerdasan? &lt;b&gt;');
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Keyinroq yozaman'));
    expect(ownerManualReply).toHaveBeenCalledWith(3, 'Keyinroq yozaman', ADMIN_ID);
    expect(sentTexts(calls)).toContain('✅ Javob yuborildi.');
  });
});

describe('pending text input', () => {
  it('prompt edit: the next text message becomes a new prompt version', async () => {
    const { deps, adminState } = baseDeps();
    const prompts = {
      getActive: vi.fn(async () => ({ version: 2, content: 'Eski prompt matni' })),
      update: vi.fn(async () => 3),
    };
    const { bot, calls } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.e'));
    expect(adminState.rows.get(ADMIN_ID.toString())?.state).toBe('pr.edit');
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Sen Komronning yordamchisisan. Qisqa javob ber.'));
    expect(prompts.update).toHaveBeenCalledWith('Sen Komronning yordamchisisan. Qisqa javob ber.', ADMIN_ID);
    expect(sentTexts(calls)).toContain('✅ Prompt saqlandi: <b>v3</b>');
    expect(adminState.rows.size).toBe(0);
  });

  it('keeps waiting after a validation error and shows a friendly message', async () => {
    const { deps, adminState } = baseDeps();
    const prompts = {
      getActive: vi.fn(async () => ({ version: 2, content: 'Eski prompt matni' })),
      update: vi.fn(async () => {
        throw new PromptValidationError('Prompt juda qisqa (kamida 10 belgi).');
      }),
    };
    const { bot, calls } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.e'));
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'qisqa'));
    expect(sentTexts(calls)).toContain('Prompt juda qisqa');
    expect(adminState.rows.get(ADMIN_ID.toString())?.state).toBe('pr.edit');
  });

  it('asks for text when a photo arrives while waiting, and /cancel clears the input', async () => {
    const { deps, adminState } = baseDeps();
    const prompts = { getActive: vi.fn(async () => ({ version: 1, content: 'x'.repeat(20) })), update: vi.fn() };
    const { bot, calls } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.e'));
    await bot.handleUpdate(photoUpdate(ADMIN_ID));
    expect(sentTexts(calls)).toContain('matn ko‘rinishida yuboring');
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/cancel'));
    expect(adminState.rows.size).toBe(0);
    expect(sentTexts(calls)).toContain('❎ Bekor qilindi.');
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'bu endi prompt emas'));
    expect(prompts.update).not.toHaveBeenCalled();
  });

  it('expired input is ignored', async () => {
    const { deps, adminState } = baseDeps();
    const prompts = { getActive: vi.fn(), update: vi.fn() };
    adminState.rows.set(ADMIN_ID.toString(), { state: 'pr.edit', payload: {}, expiresAt: new Date(Date.now() - 1000) });
    const { bot } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Yangi prompt matni shu yerda'));
    expect(prompts.update).not.toHaveBeenCalled();
    expect(adminState.rows.size).toBe(0);
  });

  it('pressing another button drops a pending input', async () => {
    const { deps, adminState } = baseDeps();
    const prompts = { getActive: vi.fn(async () => ({ version: 1, content: 'x'.repeat(20) })), update: vi.fn() };
    const { bot } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.e'));
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'm'));
    expect(adminState.rows.size).toBe(0);
  });
});

describe('safety of pending input and notifications', () => {
  it('a command abandons a pending manual reply (later text is never sent to the customer)', async () => {
    const { deps, adminState } = baseDeps();
    const get = vi.fn(async (id: number) => attentionItem(id));
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.r|3'));
    expect(adminState.rows.get(ADMIN_ID.toString())?.state).toBe('oa.reply');
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/help'));
    expect(adminState.rows.size).toBe(0);
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'bu matn mijozga ketmasligi kerak'));
    expect(ownerManualReply).not.toHaveBeenCalled();
  });

  it('an unknown /command is not consumed as the pending answer', async () => {
    const { deps, adminState } = baseDeps();
    const get = vi.fn(async (id: number) => attentionItem(id));
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.r|3'));
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/stop'));
    expect(ownerManualReply).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toContain('Noma’lum buyruq');
    expect(adminState.rows.get(ADMIN_ID.toString())?.state).toBe('oa.reply');
  });

  it('🤖 Let AI reply from a notification swaps its buttons for a progress marker', async () => {
    const { deps } = baseDeps();
    const enqueue = vi.fn(async () => 11);
    const get = vi.fn(async (id: number) => attentionItem(id));
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get }, queue: { enqueue } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.ai|7'));
    const edits = callsOf(calls, 'editMessageReplyMarkup');
    expect(edits).toHaveLength(1);
    const markup = edits[0]?.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['nop', 'oa.o|7']);
  });

  it('🤖 Let AI reply on an already-resolved item does not enqueue anything', async () => {
    const { deps } = baseDeps();
    const enqueue = vi.fn(async () => 1);
    const get = vi.fn(async (id: number) => attentionItem(id, 'REPLIED'));
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get }, queue: { enqueue } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.ai|7'));
    expect(enqueue).not.toHaveBeenCalled();
    expect(String(callsOf(calls, 'answerCallbackQuery')[0]?.payload.text)).toContain('allaqachon hal qilingan');
  });
});

describe('destructive actions need confirmation', () => {
  it('prompt reset: the first button only asks, the second resets', async () => {
    const { deps } = baseDeps();
    const prompts = {
      getActive: vi.fn(async () => ({ version: 4, content: 'Joriy prompt matni' })),
      resetDefault: vi.fn(async () => 5),
    };
    const { bot, calls } = createTestBot({ ...deps, prompts });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.r'));
    expect(prompts.resetDefault).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toContain('Standart promptga qaytarilsinmi?');
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pr.ry'));
    expect(prompts.resetDefault).toHaveBeenCalledWith(ADMIN_ID);
  });

  it('delete user data: confirmation first, then privacy.deleteUserData', async () => {
    const { deps } = baseDeps();
    const privacy = { deleteUserData: vi.fn(async () => ({ messages: 4, chats: 1 })) };
    const users = { byTelegramId: vi.fn(async () => null) };
    const { bot, calls } = createTestBot({ ...deps, privacy, users });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pv.du|123'));
    expect(privacy.deleteUserData).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toContain('butunlay o‘chiriladi');
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'pv.dy|123'));
    expect(privacy.deleteUserData).toHaveBeenCalledWith(123n, ADMIN_ID);
    expect(sentTexts(calls)).toContain('✅ O‘chirildi: 4 xabar, 1 chat.');
  });

  it('cleanup: confirmation first, then cleanup.run', async () => {
    const { deps } = baseDeps();
    const report = {
      messages: 1,
      orphanUsers: 0,
      usageRows: 0,
      events: 0,
      processedUpdates: 0,
      jobs: 0,
      adminStates: 0,
      mediaFiles: 0,
      tempFiles: 0,
      uncertainResponses: 0,
    };
    const cleanup = { run: vi.fn(async () => report) };
    const { bot, calls } = createTestBot({ ...deps, cleanup });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'adv.cl'));
    expect(cleanup.run).not.toHaveBeenCalled();
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'adv.cly'));
    expect(cleanup.run).toHaveBeenCalledTimes(1);
    expect(sentTexts(calls)).toContain('Tozalash tugadi');
  });
});

describe('AI model', () => {
  it('picking the default TTS model stores provider and model together', async () => {
    const { deps } = baseDeps();
    const registry = {
      configured: vi.fn(() => [{ id: 'gemini', displayName: 'Google Gemini' }]),
      defaultTtsModel: vi.fn(() => 'gemini-tts-model'),
      defaultTranscriptionModel: vi.fn(() => undefined),
    };
    const { bot } = createTestBot({ ...deps, registry });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'ai.d|tts|gemini'));
    expect(deps.settings.set).toHaveBeenCalledWith('ttsProvider', 'gemini', ADMIN_ID);
    expect(deps.settings.set).toHaveBeenCalledWith('ttsModel', 'gemini-tts-model', ADMIN_ID);
  });

  it('rejects a provider that is not configured', async () => {
    const { deps } = baseDeps();
    const registry = { configured: vi.fn(() => []), defaultTtsModel: vi.fn(() => 'x') };
    const { bot, calls } = createTestBot({ ...deps, registry });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'ai.d|tts|gemini'));
    expect(deps.settings.set).not.toHaveBeenCalled();
    expect(callsOf(calls, 'answerCallbackQuery')[0]?.payload.show_alert).toBe(true);
  });
});

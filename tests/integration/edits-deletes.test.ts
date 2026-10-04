import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from 'grammy/types';
import { businessMessage, buildHarness, CONNECTION_ID } from '../support/harness.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;

d('edited & deleted messages (real PostgreSQL)', () => {
  let tdb: TestDb;
  let h: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    h = await buildHarness(tdb.db, { settingsOverrides: { autoReplyEnabled: false } });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  const edit = (m: Message, text: string): Message => ({ ...m, text, edit_date: Math.floor(Date.now() / 1000) }) as Message;

  it('keeps every version and notifies the owner with OLD/NEW', async () => {
    const m = businessMessage({ text: 'Salom, ertaga ofisda bo‘lasizmi?' });
    await h.business.onMessage(m);
    await h.business.onEdited(edit(m, 'Salom, bugun ofisda bo‘lasizmi?'));
    await h.business.onEdited(edit(m, 'Salom, hozir ofisda bo‘lasizmi?'));

    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.versionCount).toBe(3);
    const versions = await h.repo.versions(msg.id);
    expect(versions.map((v) => v.text)).toEqual([
      'Salom, ertaga ofisda bo‘lasizmi?',
      'Salom, bugun ofisda bo‘lasizmi?',
      'Salom, hozir ofisda bo‘lasizmi?',
    ]);
    expect(h.cipher.decrypt(msg.currentText)).toBe('Salom, hozir ofisda bo‘lasizmi?');
    expect(h.notifier.messageEdited).toHaveBeenCalledTimes(2);
    expect(h.notifier.messageEdited.mock.calls[0]![0]).toMatchObject({
      oldText: 'Salom, ertaga ofisda bo‘lasizmi?',
      newText: 'Salom, bugun ofisda bo‘lasizmi?',
      versionNumber: 2,
    });
  });

  it('an edit event without content change creates no version (idempotent)', async () => {
    const m = businessMessage({ text: 'Bir xil' });
    await h.business.onMessage(m);
    await h.business.onEdited(edit(m, 'Bir xil'));
    await h.business.onEdited(edit(m, 'Bir xil'));
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.versionCount).toBe(1);
    expect(h.notifier.messageEdited).not.toHaveBeenCalled();
  });

  it('edits of messages never seen are stored but not claimed as tracked edits', async () => {
    const m = businessMessage({ text: 'old unseen' });
    await h.business.onEdited(edit(m, 'edited'));
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.status).toBe('SKIPPED');
    expect(h.notifier.messageEdited).not.toHaveBeenCalled();
  });

  it('deletion marks the stored message and reports the original text and all versions', async () => {
    const m = businessMessage({ text: 'Salom, ertaga ofisda bo‘lasizmi?' });
    await h.business.onMessage(m);
    await h.business.onEdited(edit(m, 'Salom, bugun ofisda bo‘lasizmi?'));
    await h.business.onDeleted({ business_connection_id: CONNECTION_ID, chat: m.chat, message_ids: [m.message_id] } as never);

    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.deletedAt).not.toBeNull();
    expect(h.notifier.messageDeleted).toHaveBeenCalledTimes(1);
    const call = h.notifier.messageDeleted.mock.calls[0]![0] as { versions: Array<{ text: string }> };
    expect(call.versions.map((v) => v.text)).toEqual(['Salom, ertaga ofisda bo‘lasizmi?', 'Salom, bugun ofisda bo‘lasizmi?']);

    // A repeated deletion event does not notify twice.
    await h.business.onDeleted({ business_connection_id: CONNECTION_ID, chat: m.chat, message_ids: [m.message_id] } as never);
    expect(h.notifier.messageDeleted).toHaveBeenCalledTimes(1);
  });

  it('never claims recovery of messages it never stored', async () => {
    const m = businessMessage({ text: 'x' });
    await h.business.onMessage(m);
    await h.business.onDeleted({ business_connection_id: CONNECTION_ID, chat: m.chat, message_ids: [999_999] } as never);
    expect(h.notifier.messageDeleted).not.toHaveBeenCalled();
    expect(h.notifier.deletedUnknown).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it('deletions from unauthorized connections are ignored', async () => {
    const m = businessMessage({ text: 'x' });
    await h.business.onMessage(m);
    await h.business.onDeleted({ business_connection_id: 'bc-unknown', chat: m.chat, message_ids: [m.message_id] } as never);
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.deletedAt).toBeNull();
  });

  it('a message deleted before the reply job runs is not answered', async () => {
    await h.settings.set('autoReplyEnabled', true);
    const m = businessMessage({ text: 'Narxi qancha?' });
    await h.business.onMessage(m);
    await h.business.onDeleted({ business_connection_id: CONNECTION_ID, chat: m.chat, message_ids: [m.message_id] } as never);
    await h.drain();
    expect(h.sent).toHaveLength(0);
  });
});

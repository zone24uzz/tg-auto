import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/database/client.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { SessionStore } from '../../src/telegram/userbot/session-store.js';

interface Row {
  id: string;
  session: string;
  ownerUserId: bigint;
}

function fakeDb() {
  const rows = new Map<string, Row>();
  const userbotSession = {
    findUnique: vi.fn(async (q: { where: { id: string } }) => rows.get(q.where.id) ?? null),
    upsert: vi.fn(async (q: { where: { id: string }; create: Row; update: Omit<Row, 'id'> }) => {
      const existing = rows.get(q.where.id);
      const row = existing ? { ...existing, ...q.update } : q.create;
      rows.set(q.where.id, row);
      return row;
    }),
    deleteMany: vi.fn(async (q: { where: { id: string } }) => ({ count: rows.delete(q.where.id) ? 1 : 0 })),
  };
  return { rows, db: { userbotSession } as unknown as Pick<Db, 'userbotSession'> };
}

const key = () => randomBytes(32).toString('base64');
const SESSION = `1BAAOMTQ5LjE1NC4xNjcuNTA${'A'.repeat(300)}=`;

describe('userbot session store', () => {
  it('stores the session encrypted and reads it back', async () => {
    const { rows, db } = fakeDb();
    const store = new SessionStore(db, new ContentCipher(key()));
    expect(await store.save(SESSION, 424242n)).toBe(true);
    const stored = rows.get('default')!;
    expect(stored.session.startsWith('enc:v1:')).toBe(true);
    expect(stored.session).not.toContain(SESSION.slice(0, 40));
    expect(stored.ownerUserId).toBe(424242n);
    expect(await store.loadDb()).toEqual({ session: SESSION, unreadable: false });
  });

  it('prefers the env session, then the database one', async () => {
    const { db } = fakeDb();
    const cipher = new ContentCipher(key());
    await new SessionStore(db, cipher).save(SESSION, 1n);
    const store = new SessionStore(db, cipher, 'ENV-SESSION-STRING');
    const { sessions } = await store.candidates();
    expect(sessions.map((s) => s.source)).toEqual(['env', 'db']);
    expect(sessions[0]!.session).toBe('ENV-SESSION-STRING');
    expect(sessions[1]!.session).toBe(SESSION);
  });

  it('reports an unreadable row when the key changed', async () => {
    const { db } = fakeDb();
    await new SessionStore(db, new ContentCipher(key())).save(SESSION, 1n);
    const other = new SessionStore(db, new ContentCipher(key()));
    expect(await other.loadDb()).toEqual({ session: null, unreadable: true });
    expect((await other.candidates()).sessions).toEqual([]);
  });

  it('never stores a plaintext session when encryption is off', async () => {
    const { rows, db } = fakeDb();
    const store = new SessionStore(db, new ContentCipher(undefined));
    expect(await store.save(SESSION, 1n)).toBe(false);
    expect(rows.size).toBe(0);
  });

  it('deletes the stored session on logout', async () => {
    const { rows, db } = fakeDb();
    const store = new SessionStore(db, new ContentCipher(key()));
    await store.save(SESSION, 1n);
    await store.clear();
    expect(rows.size).toBe(0);
    expect(await store.loadDb()).toEqual({ session: null, unreadable: false });
  });
});

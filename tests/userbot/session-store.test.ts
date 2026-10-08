import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/database/client.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { SessionStore } from '../../src/telegram/userbot/session-store.js';
import { TEST_TENANT_ID } from '../support/tenant-scope.js';

interface Row {
  tenantId: number;
  session: string;
  ownerUserId: bigint;
}

/** Keyed by tenantId (one session per workspace); the real DB scopes deleteMany({}) to the tenant. */
function fakeDb() {
  const rows = new Map<number, Row>();
  const userbotSession = {
    findUnique: vi.fn(async (q: { where: { tenantId: number } }) => rows.get(q.where.tenantId) ?? null),
    upsert: vi.fn(async (q: { where: { tenantId: number }; create: Omit<Row, 'tenantId'>; update: Omit<Row, 'tenantId'> }) => {
      const existing = rows.get(q.where.tenantId);
      const row = existing ? { ...existing, ...q.update } : { tenantId: q.where.tenantId, ...q.create };
      rows.set(q.where.tenantId, row);
      return row;
    }),
    deleteMany: vi.fn(async () => {
      const count = rows.size;
      rows.clear();
      return { count };
    }),
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
    const stored = rows.get(TEST_TENANT_ID)!;
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

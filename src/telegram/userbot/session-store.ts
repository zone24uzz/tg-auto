import type { Db } from '../../database/client.js';
import { registerSecrets } from '../../logging/sanitize.js';
import type { ContentCipher } from '../../security/crypto.js';

const ROW_ID = 'default';
/** ContentCipher.decrypt() placeholders for "no key" / "wrong key or corrupted". */
const UNREADABLE = new Set(['[encrypted]', '[unreadable]']);

export type SessionSource = 'env' | 'db';

export interface StoredSession {
  source: SessionSource;
  session: string;
}

/**
 * Where the userbot StringSession lives. TELEGRAM_SESSION from the environment wins; otherwise the
 * `userbot_sessions` row, always encrypted with ContentCipher. The session grants full access to
 * the account: it is never logged, and it is registered as a secret for the log sanitizer.
 */
export class SessionStore {
  constructor(
    private readonly db: Pick<Db, 'userbotSession'>,
    private readonly cipher: ContentCipher,
    private readonly envSession?: string,
  ) {
    registerSecrets([envSession]);
  }

  get encryptionEnabled(): boolean {
    return this.cipher.enabled;
  }

  /** Sessions to try, in priority order. */
  async candidates(): Promise<{ sessions: StoredSession[]; dbUnreadable: boolean }> {
    const sessions: StoredSession[] = [];
    const env = this.envSession?.trim();
    if (env) sessions.push({ source: 'env', session: env });
    const { session, unreadable } = await this.loadDb();
    if (session && session !== env) sessions.push({ source: 'db', session });
    return { sessions, dbUnreadable: unreadable };
  }

  /** The decrypted DB session; `unreadable` when a row exists but cannot be decrypted (key changed/missing). */
  async loadDb(): Promise<{ session: string | null; unreadable: boolean }> {
    const row = await this.db.userbotSession.findUnique({ where: { id: ROW_ID } });
    if (!row) return { session: null, unreadable: false };
    const plain = this.cipher.decrypt(row.session);
    if (!plain || UNREADABLE.has(plain)) return { session: null, unreadable: true };
    registerSecrets([plain]);
    return { session: plain, unreadable: false };
  }

  /** Stores the session encrypted. Returns false (and stores nothing) when encryption is not configured. */
  async save(session: string, ownerUserId: bigint): Promise<boolean> {
    registerSecrets([session]);
    if (!this.cipher.enabled) return false;
    const encrypted = this.cipher.encrypt(session);
    await this.db.userbotSession.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, session: encrypted, ownerUserId },
      update: { session: encrypted, ownerUserId },
    });
    return true;
  }

  async clear(): Promise<void> {
    await this.db.userbotSession.deleteMany({ where: { id: ROW_ID } });
  }
}

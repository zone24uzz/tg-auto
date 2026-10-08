import { Api, helpers, type TelegramClient } from 'telegram';
import { Raw } from 'telegram/events/index.js';
import type { PresenceState, ResolvedTelegramUser, UserbotAssistantApi } from '../../app/userbot-contract.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { toBigIntId } from './normalizer.js';

const log = childLogger('userbot-presence');
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** Maps Telegram's UserStatus to what the assistant can act on. */
export function presenceOf(status: unknown): PresenceState {
  if (status instanceof Api.UserStatusOnline) return 'online';
  if (status instanceof Api.UserStatusOffline) return 'offline';
  // "Last seen recently / within a week / month" = the user's privacy hides the exact status.
  if (status instanceof Api.UserStatusRecently) return 'recently';
  return 'hidden';
}

/** Subscribes to UpdateUserStatus pushes. Returns the unsubscribe function. */
export function registerPresenceHandler(client: TelegramClient, onPresence: (userId: bigint, state: PresenceState) => void): () => void {
  const builder = new Raw({ types: [Api.UpdateUserStatus] });
  const handler = (update: unknown) => {
    try {
      if (!(update instanceof Api.UpdateUserStatus)) return;
      const userId = toBigIntId(update.userId);
      if (userId !== undefined) onPresence(userId, presenceOf(update.status));
    } catch (error) {
      log.warn({ error: describeError(error) }, 'presence update handler failed');
    }
  };
  client.addEventHandler(handler, builder);
  return () => client.removeEventHandler(handler, builder);
}

function toResolved(user: Api.User): ResolvedTelegramUser | null {
  const id = toBigIntId(user.id);
  if (id === undefined) return null;
  return {
    id,
    accessHash: user.accessHash !== undefined && user.accessHash !== null ? String(user.accessHash) : undefined,
    username: user.username ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    isContact: user.contact === true,
    isBot: user.bot === true,
  };
}

/** The read-only MTProto helpers used by the owner's assistant; `getClient` returns null while offline. */
export function createAssistantApi(getClient: () => TelegramClient | null): UserbotAssistantApi {
  return {
    isReady: () => getClient() !== null,

    async presence(users) {
      const result = new Map<bigint, PresenceState>();
      const client = getClient();
      if (!client || users.length === 0) return result;
      const inputs: Api.TypeInputUser[] = [];
      for (const u of users) {
        try {
          if (u.accessHash && /^-?\d{1,20}$/.test(u.accessHash)) {
            inputs.push(new Api.InputUser({ userId: helpers.returnBigInt(u.id), accessHash: helpers.returnBigInt(u.accessHash) }));
            continue;
          }
          const peer = await client.getInputEntity(new Api.PeerUser({ userId: helpers.returnBigInt(u.id) }));
          if (peer instanceof Api.InputPeerUser) inputs.push(new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash }));
        } catch (error) {
          log.debug({ error: describeError(error) }, 'cannot build an input user for presence');
        }
      }
      if (inputs.length === 0) return result;
      const fetched = await client.invoke(new Api.users.GetUsers({ id: inputs }));
      for (const user of fetched) {
        if (!(user instanceof Api.User)) continue;
        const id = toBigIntId(user.id);
        if (id !== undefined) result.set(id, presenceOf(user.status));
      }
      return result;
    },

    async searchPeople(query, limit = 5) {
      const client = getClient();
      const q = query.trim();
      if (!client || q.length < 2) return [];
      try {
        const found = await client.invoke(new Api.contacts.Search({ q, limit: Math.min(Math.max(limit, 1), 10) }));
        const mine = new Set<bigint>();
        for (const peer of found.myResults) {
          if (peer instanceof Api.PeerUser) {
            const id = toBigIntId(peer.userId);
            if (id !== undefined) mine.add(id);
          }
        }
        const people: ResolvedTelegramUser[] = [];
        for (const user of found.users) {
          if (!(user instanceof Api.User) || user.bot || user.self) continue;
          const resolved = toResolved(user);
          if (resolved && mine.has(resolved.id)) people.push(resolved);
        }
        return people;
      } catch (error) {
        log.debug({ error: describeError(error) }, 'people search failed');
        return [];
      }
    },

    async resolveUsername(username) {
      const client = getClient();
      const clean = username.trim().replace(/^@/, '');
      if (!client || !USERNAME_RE.test(clean)) return null;
      try {
        const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: clean }));
        const peerId = resolved.peer instanceof Api.PeerUser ? toBigIntId(resolved.peer.userId) : undefined;
        if (peerId === undefined) return null;
        for (const user of resolved.users) {
          if (user instanceof Api.User && toBigIntId(user.id) === peerId) return toResolved(user);
        }
        return null;
      } catch (error) {
        log.debug({ error: describeError(error) }, 'username lookup failed');
        return null;
      }
    },
  };
}

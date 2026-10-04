import { Api, helpers } from 'telegram';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';

const log = childLogger('userbot-peers');

/** Looks up the stored MTProto access_hash of a user (`users.accessHash`), or null. */
export type AccessHashLookup = (userId: bigint) => Promise<string | null>;

/** The part of the GramJS client needed to resolve peers (TelegramClient satisfies it). */
export interface PeerClient {
  getInputEntity(entity: Api.PeerUser): Promise<Api.TypeInputPeer>;
}

/**
 * Resolves a private chat (user id) into an InputPeer. The access_hash stored in the database
 * makes replies work after restarts, when GramJS' in-memory entity cache is still empty.
 */
export class PeerResolver {
  constructor(private readonly lookup: AccessHashLookup) {}

  async resolve(client: PeerClient, userId: bigint): Promise<Api.TypeInputPeer> {
    let accessHash: string | null = null;
    try {
      accessHash = await this.lookup(userId);
    } catch (error) {
      log.debug({ error: describeError(error) }, 'access hash lookup failed');
    }
    if (accessHash && /^-?\d{1,20}$/.test(accessHash)) {
      return new Api.InputPeerUser({ userId: helpers.returnBigInt(userId), accessHash: helpers.returnBigInt(accessHash) });
    }
    // PeerUser (never a string: GramJS would treat strings as usernames/phone numbers).
    return client.getInputEntity(new Api.PeerUser({ userId: helpers.returnBigInt(userId) }));
  }
}

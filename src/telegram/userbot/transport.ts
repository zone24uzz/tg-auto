import { Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { RPCError } from 'telegram/errors/index.js';
import { describeError } from '../../logging/sanitize.js';
import { SendError, type UserbotTransport } from '../main/sender.js';
import { isAuthLostError } from './client.js';
import type { PeerClient, PeerResolver } from './peers.js';

/** Spacing between sends: per chat and across all chats (ban-risk hygiene for a user account). */
export const CHAT_GAP_MS = 1_500;
export const GLOBAL_GAP_MS = 500;
/** How long our own sent message ids are remembered (to tag their echo as `sentByBusinessBot`). */
export const RECENTLY_SENT_TTL_MS = 10 * 60_000;
/** Upper bound for an event handler waiting on a send that is still in flight in the same chat. */
const INFLIGHT_WAIT_MS = 15_000;

/** The part of the GramJS client the transport uses (TelegramClient satisfies it). */
export interface TransportClient extends PeerClient {
  sendMessage(entity: Api.TypeInputPeer, params: { message: string; replyTo?: number; linkPreview?: boolean }): Promise<{ id: number }>;
  sendFile(entity: Api.TypeInputPeer, params: { file: CustomFile; voiceNote?: boolean; replyTo?: number }): Promise<{ id: number }>;
  invoke(request: Api.messages.SetTyping): Promise<unknown>;
}

export interface TransportOptions {
  getClient: () => TransportClient | null;
  peers: PeerResolver;
  /** Called when Telegram reports that the session is no longer valid. */
  onAuthLost?: (error: unknown) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Sends through the owner's own account. Errors are always SendError (see UserbotTransport). */
export class MtprotoTransport implements UserbotTransport {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sent = new Map<string, number>();
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();
  private readonly nextChatAt = new Map<string, number>();
  private nextGlobalAt = 0;

  constructor(private readonly opts: TransportOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  sendText(chatId: bigint, text: string, replyTo?: number): Promise<number> {
    return this.send(chatId, (client, peer) =>
      client.sendMessage(peer, { message: text, linkPreview: false, ...(replyTo ? { replyTo } : {}) }),
    );
  }

  sendVoice(chatId: bigint, ogg: Buffer, replyTo?: number): Promise<number> {
    return this.send(chatId, (client, peer) =>
      client.sendFile(peer, { file: new CustomFile('reply.ogg', ogg.length, '', ogg), voiceNote: true, ...(replyTo ? { replyTo } : {}) }),
    );
  }

  /** Best effort; TelegramSender swallows failures. */
  async typing(chatId: bigint, action: 'typing' | 'record_voice'): Promise<void> {
    const client = this.opts.getClient();
    if (!client) return;
    const peer = await this.opts.peers.resolve(client, chatId);
    await client.invoke(
      new Api.messages.SetTyping({
        peer,
        action: action === 'record_voice' ? new Api.SendMessageRecordAudioAction() : new Api.SendMessageTypingAction(),
      }),
    );
  }

  /** True when this message id was sent by this transport within the last ~10 minutes. */
  wasSentByUs(chatId: bigint, messageId: number): boolean {
    const expiresAt = this.sent.get(`${chatId}:${messageId}`);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  /** Lets the outgoing-message handler wait until our own sends in this chat have their ids. */
  async waitForInflight(chatId: bigint, maxMs = INFLIGHT_WAIT_MS): Promise<void> {
    const pending = this.inflight.get(chatId.toString());
    if (!pending || pending.size === 0) return;
    await Promise.race([Promise.allSettled([...pending]), this.sleep(maxMs)]);
  }

  private async send(
    chatId: bigint,
    op: (client: TransportClient, peer: Api.TypeInputPeer) => Promise<{ id: number }>,
  ): Promise<number> {
    const client = this.opts.getClient();
    if (!client) throw new SendError('userbot is not connected (login required)', true);
    const key = chatId.toString();
    const task = (async () => {
      let peer: Api.TypeInputPeer;
      try {
        peer = await this.opts.peers.resolve(client, chatId);
      } catch (error) {
        // Nothing was sent yet, so this is a definite failure.
        throw new SendError(`cannot resolve the chat peer: ${describeError(error)}`, true);
      }
      await this.reserveSlot(key);
      let result: { id: number };
      try {
        result = await op(client, peer);
      } catch (error) {
        throw this.toSendError(error);
      }
      this.remember(chatId, result.id);
      return result.id;
    })();
    this.track(key, task);
    return task;
  }

  /** Reserves the next free send slot synchronously (FIFO), then waits for it. */
  private async reserveSlot(key: string): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextGlobalAt, this.nextChatAt.get(key) ?? 0);
    this.nextGlobalAt = at + GLOBAL_GAP_MS;
    this.nextChatAt.set(key, at + CHAT_GAP_MS);
    if (this.nextChatAt.size > 1_000) {
      for (const [k, t] of this.nextChatAt) if (t < now) this.nextChatAt.delete(k);
    }
    if (at > now) await this.sleep(at - now);
  }

  private track(key: string, task: Promise<unknown>): void {
    const set = this.inflight.get(key) ?? new Set<Promise<unknown>>();
    set.add(task);
    this.inflight.set(key, set);
    const done = () => {
      set.delete(task);
      if (set.size === 0 && this.inflight.get(key) === set) this.inflight.delete(key);
    };
    task.then(done, done);
  }

  private remember(chatId: bigint, messageId: number): void {
    const now = this.now();
    this.sent.set(`${chatId}:${messageId}`, now + RECENTLY_SENT_TTL_MS);
    // Insertion order == expiry order (constant TTL): drop expired entries from the front.
    for (const [k, expiresAt] of this.sent) {
      if (expiresAt > now) break;
      this.sent.delete(k);
    }
  }

  private toSendError(error: unknown): SendError {
    if (error instanceof SendError) return error;
    // An RPCError is Telegram's answer: the message was not sent. Anything else (timeouts,
    // dropped connections) leaves the outcome unknown.
    if (error instanceof RPCError) {
      if (isAuthLostError(error)) this.opts.onAuthLost?.(error);
      return new SendError(describeError(error), true);
    }
    return new SendError(describeError(error), false);
  }
}

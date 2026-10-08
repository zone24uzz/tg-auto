import type { Composer, Context } from 'grammy';
import type { ContentCipher } from '../security/crypto.js';
import type { Db } from '../database/client.js';
import type { EventLog } from '../logging/events.js';
import type { DownloadedFile, DownloadOptions, FileDownloader } from '../media/telegram-file.js';
import type { AdminNotifier } from '../telegram/admin/notifier.js';
import type { BusinessHandlers } from '../telegram/main/business.handlers.js';
import type { ConnectionService } from '../telegram/main/connection.service.js';
import type { UserbotTransport } from '../telegram/main/sender.js';

export interface MtprotoOptions {
  port: 443 | 80;
  obfuscated: boolean;
}

/** Admin-chat commands handled by the userbot composer (/login QR, /cancel_login, /logout, /userbot status). */
export const USERBOT_COMMANDS = ['login', 'cancel_login', 'logout', 'userbot'] as const;
export type UserbotCommand = (typeof USERBOT_COMMANDS)[number];

/** Prefix of media file references created by the userbot normalizer: `mt:<chatId>:<messageId>:<index>`. */
export const MTPROTO_FILE_PREFIX = 'mt:';

/** Everything the userbot (MTProto) runtime needs from the app. */
export interface UserbotRuntimeDeps {
  db: Db;
  cipher: ContentCipher;
  apiId: number;
  apiHash: string;
  /** MTProto connection: port 443 + obfuscation by default (env MTPROTO_PORT / MTPROTO_OBFUSCATED). */
  mtproto?: MtprotoOptions;
  /** Optional env-provided StringSession (otherwise the encrypted DB session is used). */
  envSession?: string;
  adminTelegramUserId: bigint;
  tmpDir: string;
  business: BusinessHandlers;
  connections: ConnectionService;
  notifier: AdminNotifier;
  events: EventLog;
  /** Called once the account is authorized and connected (attach the transport to the sender). */
  onReady: (transport: UserbotTransport) => void;
  /** Called when the session is lost/logged out. */
  onLoggedOut: () => void;
  /** Presence pushes from Telegram (UpdateUserStatus) for the owner's assistant. */
  onPresence?: (userId: bigint, state: PresenceState) => void;
}

/**
 * What Telegram reveals about a user's presence. `hidden` = their "last seen" privacy hides it from the
 * owner (then no online notification is possible).
 */
export type PresenceState = 'online' | 'offline' | 'recently' | 'hidden';

export interface ResolvedTelegramUser {
  id: bigint;
  accessHash?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  isContact?: boolean;
  isBot?: boolean;
}

/** Read-only MTProto helpers for the owner's assistant (null results when the userbot is offline). */
export interface UserbotAssistantApi {
  isReady(): boolean;
  /** Current presence of the given users (users.GetUsers); users Telegram does not return are omitted. */
  presence(users: Array<{ id: bigint; accessHash?: string | null }>): Promise<Map<bigint, PresenceState>>;
  /** Looks up a public @username. */
  resolveUsername(username: string): Promise<ResolvedTelegramUser | null>;
  /** Searches the owner's own contacts and chats by name (contacts.Search "my results" only). */
  searchPeople(query: string, limit?: number): Promise<ResolvedTelegramUser[]>;
}

export type UserbotStatus =
  | { state: 'disconnected' }
  | { state: 'login_required' }
  | { state: 'connecting' }
  | { state: 'ready'; userId: bigint; username?: string }
  | { state: 'error'; message: string };

/** Implemented by src/telegram/userbot/index.ts (`createUserbotRuntime`). */
export interface UserbotRuntime {
  /** Connects with the stored session; when none/invalid, notifies the admin to run /login. Never throws. */
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): UserbotStatus;
  /** Admin-only commands: /login (QR code + optional 2FA), /logout, /userbot (status). Must call next() otherwise. */
  composer: Composer<Context>;
  /** Downloads media referenced by `mt:` file ids (with the same size limits as the Bot API downloader). */
  downloader: FileDownloader;
  /** Presence / username lookups for the owner's assistant. */
  assistantApi: UserbotAssistantApi;
}

/** Sends `mt:` refs to the userbot downloader and everything else to the Bot API downloader. */
export class RoutingFileDownloader implements FileDownloader {
  private userbot: FileDownloader | null = null;

  constructor(private readonly botApi: FileDownloader) {}

  setUserbotDownloader(downloader: FileDownloader | null): void {
    this.userbot = downloader;
  }

  download(fileId: string, opts: DownloadOptions): Promise<DownloadedFile> {
    if (fileId.startsWith(MTPROTO_FILE_PREFIX)) {
      if (!this.userbot) return Promise.reject(new Error('userbot is not connected; cannot download MTProto media'));
      return this.userbot.download(fileId, opts);
    }
    return this.botApi.download(fileId, opts);
  }
}

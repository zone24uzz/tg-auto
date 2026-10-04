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

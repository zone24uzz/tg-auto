import { Logger, TelegramClient } from 'telegram';
import { RPCError } from 'telegram/errors/index.js';
import { ConnectionTCPFull } from 'telegram/network/connection/TCPFull.js';
import { ConnectionTCPObfuscated } from 'telegram/network/connection/TCPObfuscated.js';
import type { MtprotoOptions } from '../../app/userbot-contract.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';

/** A GramJS client together with the StringSession it writes the auth key to. */
export interface ClientBundle {
  client: TelegramClient;
  session: StringSession;
}

/** RPC errors meaning the session is gone (logged out from another device, revoked, duplicated…). */
const AUTH_LOST_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'AUTH_KEY_PERM_EMPTY',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
]);

export function isAuthLostError(error: unknown): boolean {
  return error instanceof RPCError && AUTH_LOST_ERRORS.has(error.errorMessage);
}

/**
 * Creates (does not connect) a userbot client. Replies are sent as plain text (no parse mode),
 * GramJS only logs errors, and flood waits up to 60 s are slept through automatically.
 */
export function createMtprotoClient(
  sessionString: string,
  apiId: number,
  apiHash: string,
  transport: MtprotoOptions = { port: 443, obfuscated: true },
): ClientBundle {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    // Default: port 443 + obfuscated transport. Plain MTProto on port 80 (GramJS' Node default) is blocked by
    // DPI on some networks — verified 2026-10-04: :80 hangs at the auth-key exchange, :443 connects in ~2 s.
    // GramJS picks port 443 when useWSS is true (it still uses plain TCP sockets in Node).
    useWSS: transport.port === 443,
    connection: transport.obfuscated ? ConnectionTCPObfuscated : ConnectionTCPFull,
    deviceModel: 'AI Assistant',
    appVersion: '1.0',
    baseLogger: new Logger(LogLevel.ERROR),
  });
  client.setLogLevel(LogLevel.ERROR);
  client.setParseMode(undefined);
  client.floodSleepThreshold = 60;
  return { client, session };
}

/** Disconnects and stops the update loop; never throws and never hangs longer than `timeoutMs`. */
export async function closeClient(client: { destroy(): Promise<void> }, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.destroy(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // already disconnected / broken connection: nothing left to close
  } finally {
    if (timer) clearTimeout(timer);
  }
}

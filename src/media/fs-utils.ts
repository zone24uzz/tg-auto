import { open, rm } from 'node:fs/promises';

/** Reads the first `bytes` bytes of a file (for magic-byte sniffing). */
export async function readHead(filePath: string, bytes = 64): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Best-effort removal of temp files; never throws. */
export async function removeQuietly(...paths: Array<string | null | undefined>): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      if (!p) return;
      try {
        await rm(p, { force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // ignore: the temp sweeper removes leftovers
      }
    }),
  );
}

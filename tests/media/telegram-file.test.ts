import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaTooLargeError, TelegramFileDownloader, TelegramFileError } from '../../src/media/telegram-file.js';
import { listFiles, makeTmpDir, removeDir } from './helpers.js';

const TOKEN = '123456789:AAHfakeTokenForTests_abcdefghijklmnopq';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A body stream of `chunks` × `chunkSize` bytes, without Content-Length. */
function streamBody(chunks: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
  });
}

describe('TelegramFileDownloader', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await makeTmpDir('dl-');
  });
  afterEach(async () => {
    await removeDir(tmpDir);
  });

  function downloader(fetchImpl: (url: string) => Promise<Response>, apiRoot = 'https://api.telegram.org') {
    const spy = vi.fn(async (input: string | URL | Request) => fetchImpl(String(input)));
    const dl = new TelegramFileDownloader({ token: TOKEN, apiRoot, tmpDir, fetchImpl: spy as unknown as typeof fetch });
    return { dl, spy };
  }

  it('downloads into the temp dir and sniffs the content', async () => {
    const { dl, spy } = downloader(async (url) => {
      if (url.includes('/getFile')) return json({ ok: true, result: { file_id: 'F', file_path: 'photos/file_1.jpg', file_size: 4 } });
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    });
    const file = await dl.download('F', { maxBytes: 1024 });
    expect(path.dirname(file.path)).toBe(path.resolve(tmpDir));
    expect(file.path.endsWith('.jpg')).toBe(true);
    expect(file.size).toBe(4);
    expect(file.sniffed).toBe('image/jpeg');
    expect(spy.mock.calls[1]![0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);
    expect([...(await readFile(file.path))]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it('aborts a stream larger than maxBytes, deletes the partial file and hides the token', async () => {
    const { dl } = downloader(async (url) => {
      if (url.includes('/getFile')) return json({ ok: true, result: { file_id: 'F', file_path: 'documents/file_2.pdf' } });
      return new Response(streamBody(50, 64 * 1024));
    });
    const err = await dl.download('F', { maxBytes: 100 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaTooLargeError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('api.telegram.org');
    expect(await listFiles(tmpDir)).toEqual([]);
  });

  it('refuses a declared Content-Length above the limit without writing', async () => {
    const { dl } = downloader(async (url) => {
      if (url.includes('/getFile')) return json({ ok: true, result: { file_id: 'F', file_path: 'videos/file_3.mp4' } });
      return new Response('x'.repeat(5000), { headers: { 'content-length': '5000' } });
    });
    await expect(dl.download('F', { maxBytes: 1000 })).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(await listFiles(tmpDir)).toEqual([]);
  });

  it('enforces the 20 MB cloud Bot API cap before downloading', async () => {
    const { dl, spy } = downloader(async () =>
      json({ ok: true, result: { file_id: 'F', file_path: 'videos/big.mp4', file_size: 25 * 1024 * 1024 } }),
    );
    await expect(dl.download('F', { maxBytes: 100 * 1024 * 1024, knownSize: 25 * 1024 * 1024 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    expect(spy).not.toHaveBeenCalled();
    await expect(dl.download('F', { maxBytes: 100 * 1024 * 1024 })).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(spy).toHaveBeenCalledTimes(1); // getFile only, no file transfer
  });

  it('maps "file is too big" from getFile to MediaTooLargeError', async () => {
    const { dl } = downloader(async () => json({ ok: false, description: 'Bad Request: file is too big' }, 400));
    await expect(dl.download('F', { maxBytes: 1024 })).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it('rejects file_path traversal', async () => {
    const { dl, spy } = downloader(async () => json({ ok: true, result: { file_id: 'F', file_path: 'documents/../../secret' } }));
    await expect(dl.download('F', { maxBytes: 1024 })).rejects.toBeInstanceOf(TelegramFileError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never puts the token into network error messages', async () => {
    const { dl } = downloader(async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const err = await dl.download('F', { maxBytes: 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFileError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('AAHfakeToken');
    expect((err as Error).message).not.toContain('api.telegram.org');
  });

  it('reports HTTP errors of the file endpoint without the URL', async () => {
    const { dl } = downloader(async (url) => {
      if (url.includes('/getFile')) return json({ ok: true, result: { file_id: 'F', file_path: 'voice/file_9.oga' } });
      return new Response('nope', { status: 404 });
    });
    const err = await dl.download('F', { maxBytes: 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFileError);
    expect((err as Error).message).toBe('file download failed: HTTP 404');
    expect(await listFiles(tmpDir)).toEqual([]);
  });

  it('copies absolute paths returned by a self-hosted (--local) Bot API server', async () => {
    const serverDir = await makeTmpDir('botapi-');
    try {
      const source = path.join(serverDir, 'file_7.oga');
      await writeFile(source, Buffer.from('OggS-local-data'));
      const { dl } = downloader(
        async () => json({ ok: true, result: { file_id: 'F', file_path: source, file_size: 15 } }),
        'http://127.0.0.1:8081',
      );
      const file = await dl.download('F', { maxBytes: 30 * 1024 * 1024, ext: 'ogg' });
      expect(file.sniffed).toBe('audio/ogg');
      expect((await readFile(file.path)).toString()).toBe('OggS-local-data');
      expect(path.dirname(file.path)).toBe(path.resolve(tmpDir));
    } finally {
      await removeDir(serverDir);
    }
  });
});

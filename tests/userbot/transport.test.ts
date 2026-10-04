import { Api } from 'telegram';
import { RPCError } from 'telegram/errors/index.js';
import { describe, expect, it, vi } from 'vitest';
import { SendError } from '../../src/telegram/main/sender.js';
import { PeerResolver } from '../../src/telegram/userbot/peers.js';
import { CHAT_GAP_MS, GLOBAL_GAP_MS, MtprotoTransport, type TransportClient } from '../../src/telegram/userbot/transport.js';
import { PEER_ID, big } from './helpers.js';

function rpcError(message: string, code = 400): RPCError {
  const request = new Api.messages.SetTyping({ peer: new Api.InputPeerEmpty(), action: new Api.SendMessageTypingAction() });
  return new RPCError(message, request, code);
}

function setup(opts: { accessHash?: string | null; client?: Partial<TransportClient> } = {}) {
  let nextId = 500;
  const client: TransportClient = {
    getInputEntity: vi.fn(async () => new Api.InputPeerUser({ userId: big(PEER_ID), accessHash: big(1) })),
    sendMessage: vi.fn(async () => ({ id: ++nextId })),
    sendFile: vi.fn(async () => ({ id: ++nextId })),
    invoke: vi.fn(async () => true),
    ...opts.client,
  };
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const onAuthLost = vi.fn();
  const transport = new MtprotoTransport({
    getClient: () => client,
    peers: new PeerResolver(async () => (opts.accessHash === undefined ? '12345' : opts.accessHash)),
    onAuthLost,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { transport, client, sleeps, onAuthLost, advance: (ms: number) => (clock += ms) };
}

describe('userbot transport', () => {
  it('sends plain text without link previews to the stored peer and returns the id', async () => {
    const { transport, client } = setup();
    const id = await transport.sendText(PEER_ID, 'Assalomu alaykum', 7);
    expect(id).toBe(501);
    const [peer, params] = vi.mocked(client.sendMessage).mock.calls[0]!;
    expect(peer).toBeInstanceOf(Api.InputPeerUser);
    const inputPeer = peer as Api.InputPeerUser;
    expect(inputPeer.userId.toString()).toBe(PEER_ID.toString());
    expect(inputPeer.accessHash.toString()).toBe('12345');
    expect(params).toEqual({ message: 'Assalomu alaykum', linkPreview: false, replyTo: 7 });
    expect(client.getInputEntity).not.toHaveBeenCalled();
  });

  it('falls back to the GramJS entity cache when no access hash is stored', async () => {
    const { transport, client } = setup({ accessHash: null });
    await transport.sendText(PEER_ID, 'hi');
    const arg = vi.mocked(client.getInputEntity).mock.calls[0]![0];
    expect(arg).toBeInstanceOf(Api.PeerUser);
    expect(arg.userId.toString()).toBe(PEER_ID.toString());
  });

  it('sends voice replies as voice notes', async () => {
    const { transport, client } = setup();
    await transport.sendVoice(PEER_ID, Buffer.from('OggS-fake'));
    const params = vi.mocked(client.sendFile).mock.calls[0]![1];
    expect(params.voiceNote).toBe(true);
    expect(params.file.name).toBe('reply.ogg');
    expect(params.file.size).toBe(9);
  });

  it('maps Telegram RPC errors to definitelyNotSent=true', async () => {
    const { transport } = setup({ client: { sendMessage: vi.fn(async () => Promise.reject(rpcError('PEER_FLOOD'))) } });
    const error = await transport.sendText(PEER_ID, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).definitelyNotSent).toBe(true);
    expect((error as SendError).message).toContain('PEER_FLOOD');
  });

  it('maps network/unknown errors to definitelyNotSent=false', async () => {
    const { transport } = setup({ client: { sendMessage: vi.fn(async () => Promise.reject(new Error('socket hang up'))) } });
    const error = await transport.sendText(PEER_ID, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).definitelyNotSent).toBe(false);
  });

  it('reports a lost session through onAuthLost', async () => {
    const { transport, onAuthLost } = setup({ client: { sendMessage: vi.fn(async () => Promise.reject(rpcError('AUTH_KEY_UNREGISTERED', 401))) } });
    await expect(transport.sendText(PEER_ID, 'x')).rejects.toBeInstanceOf(SendError);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('fails definitely (nothing sent) when not connected', async () => {
    const transport = new MtprotoTransport({ getClient: () => null, peers: new PeerResolver(async () => null) });
    const error = await transport.sendText(PEER_ID, 'x').catch((e: unknown) => e);
    expect((error as SendError).definitelyNotSent).toBe(true);
  });

  it('spaces sends: 1.5 s per chat and 0.5 s globally', async () => {
    const { transport, sleeps, advance } = setup();
    await transport.sendText(PEER_ID, 'a');
    expect(sleeps).toEqual([]);
    await transport.sendText(PEER_ID, 'b');
    expect(sleeps).toEqual([CHAT_GAP_MS]);
    await transport.sendText(PEER_ID + 1n, 'c'); // other chat: only the global gap applies
    expect(sleeps).toEqual([CHAT_GAP_MS, GLOBAL_GAP_MS]);
    advance(10_000);
    await transport.sendText(PEER_ID, 'd');
    expect(sleeps).toHaveLength(2);
  });

  it('remembers its own message ids for ~10 minutes', async () => {
    const { transport, advance } = setup();
    const id = await transport.sendText(PEER_ID, 'auto');
    expect(transport.wasSentByUs(PEER_ID, id)).toBe(true);
    expect(transport.wasSentByUs(PEER_ID, id + 1)).toBe(false);
    expect(transport.wasSentByUs(PEER_ID + 1n, id)).toBe(false);
    advance(11 * 60_000);
    expect(transport.wasSentByUs(PEER_ID, id)).toBe(false);
  });

  it('lets event handlers wait for in-flight sends of the same chat', async () => {
    let release: (v: { id: number }) => void = () => undefined;
    const pending = new Promise<{ id: number }>((resolve) => (release = resolve));
    const { transport } = setup({ client: { sendMessage: vi.fn(() => pending) } });
    const send = transport.sendText(PEER_ID, 'slow');
    let waited = false;
    const wait = transport.waitForInflight(PEER_ID).then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    release({ id: 900 });
    await send;
    await wait;
    expect(transport.wasSentByUs(PEER_ID, 900)).toBe(true);
  });

  it('sends typing / recording actions', async () => {
    const { transport, client } = setup();
    await transport.typing(PEER_ID, 'record_voice');
    const request = vi.mocked(client.invoke).mock.calls[0]![0];
    expect(request).toBeInstanceOf(Api.messages.SetTyping);
    expect(request.action).toBeInstanceOf(Api.SendMessageRecordAudioAction);
  });
});

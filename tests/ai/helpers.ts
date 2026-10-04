import { vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import type { Settings } from '../../src/settings/schema.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import type {
  AIProvider,
  GenerateTextRequest,
  GenerateTextResult,
  ModelInfo,
  ProviderCapabilities,
  ProviderId,
  SpeechRequest,
  SpeechResult,
  TranscribeRequest,
  TranscribeResult,
} from '../../src/ai/types.js';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body (undefined for GET / multipart). */
  json: Record<string, unknown> | undefined;
  formData: FormData | undefined;
}

export type MockReply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string>; binary?: Uint8Array }
  | Error;

/** Stubs global fetch with a FIFO queue of replies and captures every request. */
export function mockFetch(replies: MockReply[]): { calls: CapturedRequest[]; fetch: ReturnType<typeof vi.fn> } {
  const queue = [...replies];
  const calls: CapturedRequest[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      json: typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined,
      formData: body instanceof FormData ? body : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error('mockFetch: no more replies queued');
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const payload = next.binary ?? (next.text !== undefined ? next.text : JSON.stringify(next.json ?? {}));
    return new Response(payload, { status, headers: next.headers });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fetch: fn };
}

export function geminiOk(text: string, extra: { thought?: string; finishReason?: string } = {}): MockReply {
  return {
    json: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [...(extra.thought ? [{ text: extra.thought, thought: true }] : []), { text }],
          },
          finishReason: extra.finishReason ?? 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: extra.thought ? 7 : 0 },
    },
  };
}

export function baseSettings(overrides: Partial<Settings> = {}): Settings {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/test',
    TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`,
    ADMIN_TELEGRAM_USER_ID: '1',
  });
  return {
    ...buildDefaultSettings(env),
    aiProvider: 'gemini',
    aiModel: 'gemini-3.8-flash',
    fallbackProvider: null,
    fallbackModel: null,
    mediaProvider: null,
    mediaModel: null,
    transcriptionProvider: null,
    transcriptionModel: null,
    classifierProvider: null,
    classifierModel: null,
    ttsProvider: null,
    ttsModel: null,
    ttsVoice: null,
    reasoningEffort: 'low',
    globalAiRequestsPerMinute: 1000,
    ...overrides,
  };
}

export interface FakeProviderOptions {
  configured?: boolean;
  caps?: Partial<ProviderCapabilities>;
  tts?: boolean;
}

/** Fully controllable provider for router tests. */
export class FakeProvider implements AIProvider {
  readonly displayName: string;
  readonly generateText = vi.fn(
    async (req: GenerateTextRequest): Promise<GenerateTextResult> => ({
      text: `${this.id}:${req.model}`,
      usage: { inputTokens: 1000, outputTokens: 500 },
      provider: this.id,
      model: req.model,
      latencyMs: 12,
    }),
  );
  readonly analyzeImage = vi.fn(
    async (req: { model: string }): Promise<GenerateTextResult> => ({
      text: 'image',
      usage: { inputTokens: 100, outputTokens: 10 },
      provider: this.id,
      model: req.model,
      latencyMs: 5,
    }),
  );
  readonly analyzeVideoContext = vi.fn(
    async (req: { model: string }): Promise<GenerateTextResult> => ({
      text: 'video',
      usage: { inputTokens: 100, outputTokens: 10 },
      provider: this.id,
      model: req.model,
      latencyMs: 5,
    }),
  );
  readonly transcribeAudio = vi.fn(
    async (req: TranscribeRequest): Promise<TranscribeResult> => ({
      text: 'transcript',
      usage: { inputTokens: 50, outputTokens: 20 },
      provider: this.id,
      model: req.model,
      latencyMs: 7,
    }),
  );
  synthesizeSpeech?: (req: SpeechRequest) => Promise<SpeechResult>;
  readonly speech = vi.fn(
    async (req: SpeechRequest): Promise<SpeechResult> => ({
      audio: Buffer.from('ogg'),
      format: 'ogg_opus',
      usage: { inputTokens: 5, outputTokens: 50 },
      provider: this.id,
      model: req.model,
      latencyMs: 9,
    }),
  );
  private readonly configured: boolean;
  private readonly caps: ProviderCapabilities;

  constructor(
    readonly id: ProviderId,
    opts: FakeProviderOptions = {},
  ) {
    this.displayName = `fake-${id}`;
    this.configured = opts.configured ?? true;
    this.caps = {
      text: true,
      vision: true,
      audioTranscription: false,
      tts: false,
      reasoning: true,
      jsonSchema: true,
      ...opts.caps,
    };
    if (opts.tts) this.synthesizeSpeech = this.speech;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  capabilities(): ProviderCapabilities {
    return this.caps;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: `${this.id}-model` }];
  }
}

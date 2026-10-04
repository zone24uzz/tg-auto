import type { AiRouter } from '../ai/router/types.js';
import type { Ffmpeg } from '../media/ffmpeg.js';
import type { VoiceSynth } from './pipeline.js';

const MAX_TTS_CHARS = 1_500;

/** Text → Telegram voice note (OGG/Opus) via the configured TTS provider and ffmpeg. */
export class TtsVoiceSynth implements VoiceSynth {
  constructor(
    private readonly ai: AiRouter,
    private readonly ffmpeg: Ffmpeg,
  ) {}

  async toVoice(text: string, messageId: number): Promise<Buffer | null> {
    if (!(await this.ai.canSynthesizeSpeech())) return null;
    const routed = await this.ai.synthesizeSpeech({ text: text.slice(0, MAX_TTS_CHARS) }, { messageId });
    const speech = routed.result;
    if (speech.audio.length === 0) return null;
    if (speech.format === 'ogg_opus') return speech.audio;
    if (speech.format === 'pcm16') {
      return this.ffmpeg.toOggOpus(speech.audio, { inputFormat: 'pcm16', sampleRate: speech.sampleRate ?? 24_000 });
    }
    return this.ffmpeg.toOggOpus(speech.audio);
  }
}

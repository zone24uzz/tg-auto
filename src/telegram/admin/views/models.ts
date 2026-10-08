import type { Context } from 'grammy';
import type { ModelInfo, ProviderId } from '../../../ai/types.js';
import type { SettingKey, Settings } from '../../../settings/schema.js';
import { currentTenantId } from '../../../tenancy/context.js';
import { escapeHtml, quote } from '../../common/html.js';
import { cb } from '../callback-data.js';
import { editBtn } from '../controls.js';
import { InputError, ask, logFailure, setSetting, type AdminKit } from '../kit.js';
import { Kb, btn, label, pageArg, paginate, setNotice, show, type View } from '../ui.js';

const MODELS_PER_PAGE = 8;
const MODEL_CACHE_MS = 10 * 60_000;

interface TargetDef {
  label: string;
  provider: SettingKey;
  model: SettingKey;
  nullable: boolean;
  /** What null means for this target. */
  nullLabel: string;
}

export const TARGETS = {
  main: { label: '🧠 Asosiy model', provider: 'aiProvider', model: 'aiModel', nullable: false, nullLabel: '—' },
  fb: { label: '🛟 Zaxira (fallback)', provider: 'fallbackProvider', model: 'fallbackModel', nullable: true, nullLabel: 'yo‘q' },
  med: { label: '🖼 Media tahlili', provider: 'mediaProvider', model: 'mediaModel', nullable: true, nullLabel: 'asosiy model bilan bir xil' },
  tr: {
    label: '🎙 Transkripsiya',
    provider: 'transcriptionProvider',
    model: 'transcriptionModel',
    nullable: true,
    nullLabel: 'standart / asosiy provayder',
  },
  cl: { label: '🔍 Klassifikator', provider: 'classifierProvider', model: 'classifierModel', nullable: true, nullLabel: 'asosiy model bilan bir xil' },
  tts: { label: '🔊 Ovozli javob (TTS)', provider: 'ttsProvider', model: 'ttsModel', nullable: true, nullLabel: 'o‘rnatilmagan' },
} as const satisfies Record<string, TargetDef>;

export type TargetCode = keyof typeof TARGETS;

export function isTargetCode(v: string): v is TargetCode {
  return v in TARGETS;
}

export interface ProviderOpt {
  id: ProviderId;
  displayName: string;
}

function current(s: Settings, code: TargetCode): { provider: string | null; model: string | null } {
  const t = TARGETS[code];
  return { provider: (s[t.provider] as string | null) ?? null, model: (s[t.model] as string | null) ?? null };
}

function formatTarget(s: Settings, code: TargetCode, providers: ProviderOpt[]): string {
  const { provider, model } = current(s, code);
  if (!provider) return `<i>${TARGETS[code].nullLabel}</i>`;
  const warn = providers.some((p) => p.id === provider) ? '' : ' ⚠️ <i>sozlanmagan</i>';
  return `<code>${escapeHtml(provider)}</code> / <code>${escapeHtml(model ?? '—')}</code>${warn}`;
}

export function buildModelOverview(s: Settings, providers: ProviderOpt[]): View {
  const lines = ['🧠 <b>AI MODEL</b>', ''];
  for (const code of Object.keys(TARGETS) as TargetCode[]) lines.push(`${TARGETS[code].label}: ${formatTarget(s, code, providers)}`);
  lines.push(`⚙️ Reasoning: <b>${s.reasoningEffort}</b>`, '');
  lines.push(
    providers.length
      ? `Ulangan provayderlar: ${providers.map((p) => escapeHtml(p.displayName)).join(', ')}`
      : '⚠️ Hech bir AI provayder sozlanmagan — serverdagi .env faylida API kalitini kiriting.',
    '',
    'O‘zgartirish uchun maqsadni tanlang:',
  );
  const kb = new Kb()
    .grid((Object.keys(TARGETS) as TargetCode[]).map((code) => btn(TARGETS[code].label, cb('ai.t', code))), 2)
    .row(btn('⚙️ Reasoning Effort', 're'))
    .back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function buildTargetView(code: TargetCode, s: Settings, providers: ProviderOpt[]): View {
  const t = TARGETS[code];
  const cur = current(s, code);
  const lines = [`<b>${t.label}</b>`, '', `Hozir: ${formatTarget(s, code, providers)}`];
  if (code === 'tts') {
    lines.push(
      `🗣 Ovoz: ${s.ttsVoice ? `<code>${escapeHtml(s.ttsVoice)}</code>` : '<i>standart</i>'}`,
      '',
      'ℹ️ Ovozli javoblar uchun TTS’ni qo‘llaydigan provayder kerak (masalan, Gemini yoki OpenAI).',
    );
  }
  if (code === 'tr' || code === 'tts') lines.push('ℹ️ Ro‘yxatda chat modellari ham chiqishi mumkin — kerak bo‘lsa model ID ni qo‘lda kiriting.');
  lines.push('', providers.length ? 'Provayderni tanlang — so‘ng model tanlanadi:' : '⚠️ Sozlangan provayder yo‘q.');
  const kb = new Kb().grid(
    providers.map((p) => btn(`${cur.provider === p.id ? '✅ ' : ''}${p.displayName}`, cb('ai.p', code, p.id, 0))),
    2,
  );
  if (cur.provider && providers.some((p) => p.id === cur.provider)) {
    kb.row(btn('✍️ Model ID ni qo‘lda kiritish', cb('ai.e', code, cur.provider)));
  }
  if (t.nullable) kb.row(btn(`🚫 Yo‘q / ${t.nullLabel}`, cb('ai.n', code)));
  if (code === 'tts') kb.row(editBtn('tv', 'Ovoz (voice)'));
  return { text: lines.join('\n'), keyboard: kb.back('ai').build() };
}

export function modelLabel(m: ModelInfo): string {
  return m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id;
}

export function buildModelPicker(
  code: TargetCode,
  provider: ProviderOpt,
  models: ModelInfo[],
  page: number,
  currentModel: string | null,
  failed = false,
  /** Provider's default transcription/TTS model (offered first for those targets). */
  defaultModel?: string,
): View {
  const info = paginate(models.length, page, MODELS_PER_PAGE);
  const lines = [`<b>${TARGETS[code].label}</b>`, `Provayder: <b>${escapeHtml(provider.displayName)}</b>`, ''];
  if (failed) lines.push('⚠️ Model ro‘yxatini olib bo‘lmadi. Model ID ni qo‘lda kiriting.');
  else if (models.length === 0) lines.push('Model ro‘yxati bo‘sh. Model ID ni qo‘lda kiriting.');
  else lines.push(`Modelni tanlang (${models.length} ta):`);
  const kb = new Kb();
  if (defaultModel) {
    kb.row(btn(label(`${defaultModel === currentModel ? '✅ ' : '⭐ '}Standart: ${defaultModel}`, 56), cb('ai.d', code, provider.id)));
  }
  models.slice(info.skip, info.skip + MODELS_PER_PAGE).forEach((m, i) => {
    kb.row(btn(label(`${m.id === currentModel ? '✅ ' : ''}${modelLabel(m)}`, 56), cb('ai.m', code, provider.id, info.skip + i)));
  });
  kb.pager(info, (p) => cb('ai.p', code, provider.id, p))
    .row(btn('✍️ Qo‘lda kiritish', cb('ai.e', code, provider.id)))
    .back(cb('ai.t', code));
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function registerModels(kit: AdminKit): void {
  const { router, deps } = kit;
  // Keyed by tenant + provider: every workspace uses its own API key (different model lists).
  const cache = new Map<string, { models: ModelInfo[]; at: number }>();

  const providers = (): ProviderOpt[] => deps.registry.configured().map((p) => ({ id: p.id, displayName: p.displayName }));
  const providerOf = (id: string): ProviderOpt | undefined => providers().find((p) => p.id === id);

  const models = async (id: ProviderId): Promise<{ models: ModelInfo[]; failed: boolean }> => {
    const key = `${currentTenantId('models')}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return { models: hit.models, failed: false };
    try {
      const list = (await deps.registry.listModels(id)).filter((m) => m.id.length > 0);
      cache.set(key, { models: list, at: Date.now() });
      return { models: list, failed: false };
    } catch (error) {
      logFailure(kit, `listModels(${id})`, error);
      return { models: [], failed: true };
    }
  };

  /** Validates both values first so provider and model never end up half-changed. */
  const apply = async (ctx: Context, code: TargetCode, provider: ProviderId | null, model: string | null) => {
    const t = TARGETS[code];
    deps.settings.validate(t.provider, provider);
    deps.settings.validate(t.model, model);
    await setSetting(kit, ctx, t.provider, provider);
    await setSetting(kit, ctx, t.model, model);
  };

  /** Default transcription / TTS model of a provider (chat models are listed separately). */
  const defaultFor = (code: TargetCode, id: ProviderId): string | undefined =>
    code === 'tr' ? deps.registry.defaultTranscriptionModel(id) : code === 'tts' ? deps.registry.defaultTtsModel(id) : undefined;

  const showTarget = async (ctx: Context, code: TargetCode) => {
    await show(ctx, buildTargetView(code, await deps.settings.get(), providers()));
  };

  router.action('ai', async (ctx) => {
    await show(ctx, buildModelOverview(await deps.settings.get(), providers()));
  });

  router.action('ai.t', async (ctx, [code = '']) => {
    if (!isTargetCode(code)) return { text: 'Bu tugma eskirgan.', alert: true };
    await showTarget(ctx, code);
  });

  router.action('ai.p', async (ctx, [code = '', pid = '', page]) => {
    const provider = providerOf(pid);
    if (!isTargetCode(code) || !provider) return { text: 'Provayder sozlanmagan yoki tugma eskirgan.', alert: true };
    const [s, list] = await Promise.all([deps.settings.get(), models(provider.id)]);
    const cur = current(s, code);
    await show(
      ctx,
      buildModelPicker(
        code,
        provider,
        list.models,
        pageArg(page),
        cur.provider === provider.id ? cur.model : null,
        list.failed,
        defaultFor(code, provider.id),
      ),
    );
  });

  router.action('ai.d', async (ctx, [code = '', pid = '']) => {
    const provider = providerOf(pid);
    const model = provider && isTargetCode(code) ? defaultFor(code, provider.id) : undefined;
    if (!provider || !isTargetCode(code) || !model) return { text: 'Bu tugma eskirgan.', alert: true };
    await apply(ctx, code, provider.id, model);
    setNotice(ctx, `✅ ${TARGETS[code].label}: <code>${escapeHtml(provider.id)}</code> / <code>${escapeHtml(model)}</code>`);
    await showTarget(ctx, code);
    return '✅ Saqlandi';
  });

  router.action('ai.m', async (ctx, [code = '', pid = '', rawIdx = '']) => {
    const provider = providerOf(pid);
    if (!isTargetCode(code) || !provider || !/^\d{1,4}$/.test(rawIdx)) return { text: 'Bu tugma eskirgan.', alert: true };
    const model = (await models(provider.id)).models[Number(rawIdx)];
    if (!model) return { text: 'Model ro‘yxati o‘zgardi — qaytadan tanlang.', alert: true };
    await apply(ctx, code, provider.id, model.id);
    setNotice(ctx, `✅ ${TARGETS[code].label}: <code>${escapeHtml(provider.id)}</code> / <code>${escapeHtml(model.id)}</code>`);
    await showTarget(ctx, code);
    return '✅ Saqlandi';
  });

  router.action('ai.e', async (ctx, [code = '', pid = '']) => {
    const provider = providerOf(pid);
    if (!isTargetCode(code) || !provider) return { text: 'Provayder sozlanmagan yoki tugma eskirgan.', alert: true };
    await ask(
      kit,
      ctx,
      'ai.model',
      { t: code, p: provider.id, back: cb('ai.t', code) },
      `✍️ <b>${TARGETS[code].label}</b> — ${escapeHtml(provider.displayName)}\nModel ID sini yuboring (masalan: <code>gemini-3.5-flash</code>).`,
    );
  });

  router.input('ai.model', async (ctx, text, payload) => {
    const code = String(payload.t ?? '');
    const provider = providerOf(String(payload.p ?? ''));
    if (!isTargetCode(code) || !provider) throw new InputError('Provayder endi sozlanmagan. /menu dan qayta boshlang.');
    const model = text.trim();
    await apply(ctx, code, provider.id, model);
    setNotice(ctx, `✅ ${TARGETS[code].label}: <code>${escapeHtml(provider.id)}</code> / <code>${quote(model, 120)}</code>`);
    await showTarget(ctx, code);
  });

  router.action('ai.n', async (ctx, [code = '']) => {
    if (!isTargetCode(code) || !TARGETS[code].nullable) return { text: 'Bu tugma eskirgan.', alert: true };
    await apply(ctx, code, null, null);
    await showTarget(ctx, code);
    return '✅ Saqlandi';
  });
}

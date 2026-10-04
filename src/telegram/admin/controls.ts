import { quote } from '../common/html.js';
import { cb } from './callback-data.js';
import { FIELDS, parseCallbackValue, parseTextValue } from './fields.js';
import { InputError, ask, setSetting, type AdminKit } from './kit.js';
import { btn, check, radio, setNotice, type Btn } from './ui.js';

/** Generic settings buttons. `screen` overrides the field's default return screen (arg-free route only). */
const withScreen = (screen?: string): string[] => (screen ? [screen] : []);

export function toggleBtn(code: string, on: boolean, text: string, screen?: string): Btn {
  return btn(check(on, text), cb('sv', code, on ? 0 : 1, ...withScreen(screen)));
}

export function choiceBtn(code: string, value: string | number, selected: boolean, text: string, screen?: string): Btn {
  return btn(radio(selected, text), cb('sv', code, value, ...withScreen(screen)));
}

export function presetBtns(
  code: string,
  values: readonly number[],
  current: number,
  fmt: (v: number) => string = String,
  screen?: string,
): Btn[] {
  return values.map((v) => choiceBtn(code, v, Math.abs(v - current) < 1e-9, fmt(v), screen));
}

export function editBtn(code: string, text: string, screen?: string): Btn {
  return btn(text ? `✏️ ${text}` : '✏️', cb('ed', code, ...withScreen(screen)));
}

/** Registers `sv` (set value), `ed` (ask for text) and the matching text input. */
export function registerSettingControls(kit: AdminKit): void {
  const { router } = kit;

  const screenFor = (fallback: string, override?: string): string =>
    override && !override.includes('|') && router.hasAction(override) ? override : fallback;

  router.action('sv', async (ctx, [code = '', raw = '', screen]) => {
    const def = FIELDS[code];
    if (!def) return { text: 'Bu tugma eskirgan.', alert: true };
    await setSetting(kit, ctx, def.key, parseCallbackValue(def, raw));
    await router.go(ctx, screenFor(def.screen, screen));
    return '✅ Saqlandi';
  });

  router.action('ed', async (ctx, [code = '', screen]) => {
    const def = FIELDS[code];
    if (!def || (def.kind !== 'text' && def.kind !== 'optText' && def.kind !== 'num')) {
      return { text: 'Bu tugma eskirgan.', alert: true };
    }
    const current = (await kit.deps.settings.get())[def.key];
    const shown =
      current === null || current === '' ? '<i>(bo‘sh)</i>' : `<blockquote>${quote(String(current), 1500)}</blockquote>`;
    await ask(
      kit,
      ctx,
      'set.text',
      { code, back: screenFor(def.screen, screen) },
      [`✏️ <b>${quote(def.label, 100)}</b>`, '', 'Hozirgi qiymat:', shown, def.hint ? `\nℹ️ ${quote(def.hint, 200)}` : '', '', 'Yangi qiymatni yuboring.']
        .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
        .join('\n'),
    );
  });

  router.input('set.text', async (ctx, text, payload) => {
    const def = FIELDS[String(payload.code ?? '')];
    if (!def) throw new InputError('Bu so‘rov eskirgan. /menu dan qayta boshlang.');
    await setSetting(kit, ctx, def.key, parseTextValue(def, text));
    setNotice(ctx, '✅ Saqlandi.');
    await router.go(ctx, String(payload.back ?? def.screen));
  });
}

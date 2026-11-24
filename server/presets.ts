import { db } from './http.js'
import { FONT, type SpecFont } from './typo.js'

// Шрифтові пари для тексту агента на фото (сет 6, голосові Іри 20.11: «все одним шрифтом, рукописних літер нема»).
// Рішення Іри 23.09 (TSK-191): готель / трансфер / інфо — Tenor Sans без рукопису; досвід, family, думки — серифний шрифт
// з рукописною першою літерою. Мінімал — лише заголовок, без надпису зверху (атмосферні фото говорять самі).
// Пресет обирає код за рубрикою (порт pickVisualStyle з PostGenerator_src/prompt.js) і запам'ятовує в render_params.visual_style,
// тож пари чергуються самі разом із рубриками тижня. Іра може змінити стиль поста в редакторі (обкладинка) і «Запам'ятати для всіх»
// (render_prefs, scope global, key style:<назва>) — тоді так виглядатимуть усі пости цього стилю, крім тих, де текст її власний.
// Ті самі пресети — у src/lib/photoSpec.ts (PRESETS): міняєш тут — міняй там.

export type StyleKey = 'hotel' | 'thought' | 'minimal'
export const STYLE_KEYS: StyleKey[] = ['hotel', 'thought', 'minimal']
// 'classic' — вигляд до сету 6 (старий textLayer): пости, які Іра вже затвердила / виклала, не змінюються
export type VisualStyle = StyleKey | 'classic'

export type Look = { font: SpecFont; size: number; lh: number; cap: 'upper' | 'hand' | null }
// kicker — надпис зверху (Країна · Готель) на обкладинці, null — не показуємо; title — заголовок обкладинки; caption — підписи фото 2–10
export type Preset = { kicker: Look | null; title: Look; caption: Look }

export const PRESETS: Record<StyleKey, Preset> = {
  hotel: {
    kicker: { font: 'tenor', size: 0.026, lh: 1.3, cap: 'upper' },
    title: { font: 'tenor', size: 0.058, lh: 1.22, cap: null },
    caption: { font: 'tenor', size: 0.043, lh: 1.22, cap: null },
  },
  thought: {
    kicker: { font: 'tenor', size: 0.026, lh: 1.3, cap: 'upper' },
    title: { font: 'cormorant', size: 0.0748, lh: 1.18, cap: 'hand' },
    caption: { font: 'cormorant', size: 0.055, lh: 1.18, cap: null },
  },
  minimal: {
    kicker: null,
    title: { font: 'cormorant', size: 0.062, lh: 1.2, cap: null },
    caption: { font: 'cormorant', size: 0.05, lh: 1.2, cap: null },
  },
}

// Рубрика → стиль. Порядок як у pickVisualStyle: явний вибір → рубрика → є готель → думка
export function pickStyle(pillar: string | null | undefined, hasHotel: boolean): StyleKey {
  const p = String(pillar ?? '').toLowerCase()
  if (/atmos|атмосф|minimal|мінімал/.test(p)) return 'minimal'
  if (/personal|family|inspir|story|behind|expert|особист|натхнен|сім/.test(p)) return 'thought'
  if (/hotel|insider|offer|unusual|готел|transfer|трансфер|useful|info|корисн|logist/.test(p)) return 'hotel'
  return hasHotel ? 'hotel' : 'thought'
}

export const isStyle = (v: unknown): v is StyleKey => typeof v === 'string' && (STYLE_KEYS as string[]).includes(v)

// Межі як у cleanSpec (server/render.ts) — значення з апки / бази обрізаємо, сміття відкидаємо
function cleanLook(raw: unknown, fallback: Look, capOk: boolean): Look {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  const n = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v) * 10000) / 10000)) : d)
  const font = typeof r.font === 'string' && r.font in FONT ? (r.font as SpecFont) : fallback.font
  const cap = r.cap === 'upper' ? 'upper' : r.cap === 'hand' && capOk ? 'hand' : null
  return { font, size: n(r.size, 0.012, 0.2, fallback.size), lh: n(r.lh, 0.8, 2, fallback.lh), cap }
}
export function cleanPreset(raw: unknown, base: Preset): Preset {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    kicker: r.kicker === null ? null : cleanLook(r.kicker, base.kicker ?? PRESETS.hotel.kicker!, false),
    title: cleanLook(r.title, base.title, true),
    caption: cleanLook(r.caption, base.caption, false),
  }
}

// Пресети з урахуванням «Запам'ятати для всіх» Іри. Таблиці нема / помилка — вбудовані (пости все одно малюються)
export async function loadPresets(): Promise<Record<StyleKey, Preset>> {
  const r = await db().from('render_prefs').select('key, value').eq('scope', 'global').eq('scope_value', '').like('key', 'style:%')
  const out = { ...PRESETS }
  if (r.error) return out
  for (const row of r.data ?? []) {
    const k = String(row.key).slice('style:'.length)
    if (isStyle(k)) out[k] = cleanPreset(row.value, PRESETS[k])
  }
  return out
}

export async function savePreset(style: StyleKey, raw: unknown): Promise<Preset> {
  const value = cleanPreset(raw, PRESETS[style])
  const r = await db().from('render_prefs').upsert(
    { scope: 'global', scope_value: '', key: `style:${style}`, value, updated_at: new Date().toISOString() },
    { onConflict: 'scope,scope_value,key' },
  )
  if (r.error) throw r.error
  return value
}

export async function resetPreset(style: StyleKey) {
  const r = await db().from('render_prefs').delete().eq('scope', 'global').eq('scope_value', '').eq('key', `style:${style}`)
  if (r.error) throw r.error
}

// Редактор тексту на фото поста (сет 5): спека render_params.photo_spec[media_id] і миттєве DOM-прев'ю.
// Числа — копія server/typo.ts і server/overlay.ts specLayer: міняєш там — міняй тут (сервер малює фінал, DOM — лише поки сервер думає).

export type SpecFont = 'cormorant' | 'tenor' | 'hand'
// cap: 'upper' — капсом; 'hand' — велика рукописна перша літера заголовка (сет 6)
export type SpecBlock = { role: 'kicker' | 'title'; text: string; font: SpecFont; size: number; lh: number; gold: number[]; cap?: 'upper' | 'hand' | null }
export type PhotoSpec = { v: 1; x: number; y: number; w: number; veil: number | null; color: 'light' | 'dark'; blocks: SpecBlock[]; source: 'ira' | 'ai' }
// Розміри файлу, який малює сервер (рамка, зони інтерфейсу сторіз) — DOM-прев'ю будуємо в тих самих пікселях і масштабуємо
export type SpecFrame = { w: number; h: number; pad: number; inset: number }

export const SPEC_FONT: Record<SpecFont, { name: string; family: string; weight: number; space: number; script: boolean; asc: number; desc: number }> = {
  cormorant: { name: 'Cormorant', family: '"Cormorant Garamond", serif', weight: 500, space: 0.234, script: false, asc: 0.924, desc: 0.287 },
  tenor: { name: 'Tenor', family: '"Tenor Sans", sans-serif', weight: 400, space: 0.35, script: false, asc: 0.92, desc: 0.25 },
  hand: { name: 'Рукописний', family: '"Marck Script", cursive', weight: 400, space: 0.48, script: true, asc: 0.864, desc: 0.385 },
}

// Рукописна велика літера — копія CAP / CAP_OK / capBox з server/typo.ts
export const CAP = { font: 'hand' as SpecFont, scale: 2, drop: 0.42, kern: 0.03 }
const CAP_OK = new Set([...'АБВГЄЖЗИІЙКЛМНОПРСУЦЧШЩЯABCDHIJKLMNOPQUWYZ'])
export const capLetter = (text: string) => {
  const c = text.trimStart()[0]?.toUpperCase()
  return c && CAP_OK.has(c) ? c : null
}
export const capOf = (b: SpecBlock) => (b.cap === 'hand' && b.role === 'title' && !(SPEC_FONT[b.font] ?? SPEC_FONT.cormorant).script ? capLetter(b.text) : null)
export function capBox(titleFont: SpecFont, size: number, lh: number) {
  const t = SPEC_FONT[titleFont] ?? SPEC_FONT.cormorant
  const c = SPEC_FONT[CAP.font]
  const cs = Math.round(size * CAP.scale)
  const mt = Math.round(((lh - t.asc - t.desc) / 2 + t.asc) * size + CAP.drop * size - ((1 - c.asc - c.desc) / 2 + c.asc) * cs)
  return { size: cs, mt, mb: Math.round(size * lh) - mt - cs, mr: Math.round(CAP.kern * size) }
}
export const CREAM = '#F3EBDD'
export const GRAPH = '#2F2B27'
export const GOLD = '#C9B27C'
export const TRACK_UPPER = 0.16
export const GAP = 16 / 1080
export const SPEC_TEXT_MAX = 140

// Межі повзунків (сервер обрізає так само — cleanSpec у server/render.ts)
export const SIZE = { min: 0.015, max: 0.16 }
export const LH = { min: 0.8, max: 1.8 }
export const WIDTH = { min: 0.4, max: 1 }
export const VEIL_MAX = 0.85
// Вуаль «авто» в DOM-прев'ю — приблизно (точну силу рахує сервер від яскравості під текстом)
export const VEIL_AUTO = 0.45

export const words = (s: string) => s.split(/\s+/).filter(Boolean)

// Рядки блоку → групи слів з наскрізним номером (як blockLines у server/typo.ts): коротке слово склеєне з наступним
export type Word = { text: string; n: number }
export function blockLines(text: string): (Word[][] | null)[] {
  let n = -1
  return text.split('\n').map((line) => {
    const ws = words(line)
    if (!ws.length) return null
    const groups: Word[][] = []
    let cur: Word[] = []
    ws.forEach((w, i) => {
      cur.push({ text: w.replace(/(\d)([–—-])(\d)/g, '$1$2⁠$3'), n: ++n })
      if (!(/^\p{L}{1,2}$/u.test(w) && i < ws.length - 1)) { groups.push(cur); cur = [] }
    })
    if (cur.length) groups.push(cur)
    return groups
  })
}

// Кегль / розрядка / відступ між словами в пікселях файлу
export function blockLook(b: SpecBlock, f: SpecFrame) {
  const font = SPEC_FONT[b.font] ?? SPEC_FONT.cormorant
  const size = Math.max(8, Math.round(b.size * (f.w - 2 * f.pad)))
  const upper = !font.script && b.cap === 'upper'
  const track = upper ? TRACK_UPPER * size : 0
  return { font, size, upper, track, sp: font.space * size + track }
}

// Переписала текст — золото лишається на тих самих словах, а не на тих самих номерах
export function keepGold(oldText: string, gold: number[], text: string) {
  const was = new Set(gold.map((i) => words(oldText)[i]).filter(Boolean))
  return words(text).flatMap((w, i) => (was.has(w) ? [i] : []))
}

// «Острів, де *час* повільніший» (варіант агента) → текст + золото
export function fromStars(s: string) {
  const ws = words(s)
  return { text: ws.map((w) => w.replace(/\*/g, '')).join(' '), gold: ws.flatMap((w, i) => (w.startsWith('*') || w.endsWith('*') ? [i] : [])) }
}

export const sameSpec = (a: PhotoSpec | null, b: PhotoSpec | null) => JSON.stringify(a && { ...a, source: null }) === JSON.stringify(b && { ...b, source: null })

// ───────────── Шрифтові пари (сет 6) — копія PRESETS з server/presets.ts ─────────────
// Сервер віддає діючі пресети (з «Запам'ятати для всіх») у photo_preview; ці — стандартні (демо і запасний варіант)
export type StyleKey = 'hotel' | 'thought' | 'minimal'
export type VisualStyle = StyleKey | 'classic'
export type Look = { font: SpecFont; size: number; lh: number; cap: 'upper' | 'hand' | null }
export type Preset = { kicker: Look | null; title: Look; caption: Look }
export const STYLE_KEYS: StyleKey[] = ['hotel', 'thought', 'minimal']
export const STYLE_NAME: Record<StyleKey, string> = { hotel: 'Готель', thought: 'Думка', minimal: 'Мінімал' }
export const STYLE_HINT: Record<StyleKey, string> = {
  hotel: 'Tenor Sans: надпис зверху + заголовок. Готель, трансфер, ціни',
  thought: 'Cormorant + рукописна перша літера. Досвід, сім’я, думки',
  minimal: 'Лише заголовок, без надпису зверху. Атмосферні фото',
}
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

// Довгий заголовок обкладинки — трохи дрібніше (як agentSpec у server/render.ts)
const LONG = 34
const LONG_MUL = 0.853
const r4 = (v: number) => Math.round(v * 10000) / 10000

// Обрала стиль у редакторі → шрифти, розміри, рукописна літера блоків цього фото; текст і місце лишаються.
// Стиль без надпису зверху (Мінімал) прибирає надпис; рукописна літера — лише на обкладинці
export function applyPreset(spec: PhotoSpec, p: Preset, cover: boolean): PhotoSpec {
  const blocks = spec.blocks.flatMap((b): SpecBlock[] => {
    if (b.role === 'kicker') return p.kicker ? [{ ...b, font: p.kicker.font, size: p.kicker.size, lh: p.kicker.lh, cap: p.kicker.cap === 'upper' ? 'upper' : null }] : []
    const L = cover ? p.title : p.caption
    return [{ ...b, font: L.font, size: r4(L.size * (cover && b.text.length > LONG ? LONG_MUL : 1)), lh: L.lh, cap: L.cap === 'upper' ? 'upper' : L.cap === 'hand' && cover ? 'hand' : null }]
  })
  return { ...spec, blocks }
}

// «Запам'ятати для всіх»: обкладинка, як її зробила Іра → пресет стилю. Підписи фото 2–10 — тим самим шрифтом, у тій самій пропорції
export function presetFromSpec(spec: PhotoSpec, cur: Preset): Preset {
  const k = spec.blocks.find((b) => b.role === 'kicker')
  const t = spec.blocks.find((b) => b.role === 'title')
  if (!t) return cur
  const size = r4(t.size / (t.text.length > LONG ? LONG_MUL : 1))
  return {
    kicker: k ? { font: k.font, size: k.size, lh: k.lh, cap: k.cap === 'upper' ? 'upper' : null } : null,
    title: { font: t.font, size, lh: t.lh, cap: t.cap ?? null },
    caption: { font: t.font, size: r4(cur.caption.size * (size / cur.title.size)), lh: t.lh, cap: null },
  }
}

// Чи вигляд обкладинки вже такий, як у пресеті (кнопка «Запам'ятати» тоді не потрібна)
export const samePreset = (a: Preset, b: Preset) => JSON.stringify(a) === JSON.stringify(b)

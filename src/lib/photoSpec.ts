// Редактор тексту на фото поста (сет 5): спека render_params.photo_spec[media_id] і миттєве DOM-прев'ю.
// Числа — копія server/typo.ts і server/overlay.ts specLayer: міняєш там — міняй тут (сервер малює фінал, DOM — лише поки сервер думає).

export type SpecFont = 'cormorant' | 'tenor' | 'hand'
export type SpecBlock = { role: 'kicker' | 'title'; text: string; font: SpecFont; size: number; lh: number; gold: number[]; cap?: 'upper' | null }
export type PhotoSpec = { v: 1; x: number; y: number; w: number; veil: number | null; color: 'light' | 'dark'; blocks: SpecBlock[]; source: 'ira' | 'ai' }
// Розміри файлу, який малює сервер (рамка, зони інтерфейсу сторіз) — DOM-прев'ю будуємо в тих самих пікселях і масштабуємо
export type SpecFrame = { w: number; h: number; pad: number; inset: number }

export const SPEC_FONT: Record<SpecFont, { name: string; family: string; weight: number; space: number; script: boolean }> = {
  cormorant: { name: 'Cormorant', family: '"Cormorant Garamond", serif', weight: 500, space: 0.234, script: false },
  tenor: { name: 'Tenor', family: '"Tenor Sans", sans-serif', weight: 400, space: 0.35, script: false },
  hand: { name: 'Рукописний', family: '"Marck Script", cursive', weight: 400, space: 0.48, script: true },
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

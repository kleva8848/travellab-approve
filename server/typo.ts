import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Спільна типографіка тексту на фото поста (overlay.ts: старий textLayer і редактор Іри specLayer).
// Шрифти й рядок «слова flex-елементами» — як у server/video_layers.ts (line()). Сам video_layers.ts лишає свою копію:
// воркер на VPS запускає його напряму через node (скрипт scripts/video_layers.mjs) без відносних імпортів.
// Ті самі числа — у src/lib/photoSpec.ts (миттєве DOM-прев'ю в редакторі): змінюєш тут — міняй і там.

export type SpecFont = 'cormorant' | 'tenor' | 'hand'
// space — ширина пробілу (частка кегля) з TTF (cmap → hmtx), щоб відступ між словами-елементами = звичайний пробіл
// asc / desc — hhea (= OS/2 typo) з TTF, частки кегля: де в рядку лежить базова лінія (для рукописної літери)
export const FONT: Record<SpecFont, { name: string; file: string; weight: 400 | 500; space: number; script: boolean; asc: number; desc: number }> = {
  cormorant: { name: 'Cormorant Garamond', file: 'CormorantGaramond-Medium.ttf', weight: 500, space: 0.234, script: false, asc: 0.924, desc: 0.287 },
  tenor: { name: 'Tenor Sans', file: 'TenorSans-Regular.ttf', weight: 400, space: 0.35, script: false, asc: 0.92, desc: 0.25 },
  // тимчасова заміна Buongiorno Rastellino (сет 6) — безкоштовний Marck Script з кирилицею
  hand: { name: 'Marck Script', file: 'MarckScript-Regular.ttf', weight: 400, space: 0.48, script: true, asc: 0.864, desc: 0.385 },
}

// ───────────── Рукописна велика літера (сет 6): cap 'hand' — перша літера заголовка обкладинки ─────────────
// Шрифт літери — CAP.font. Buongiorno Rastellino (коли Rentafont письмово скаже «так») — заміна тут.
// scale — кегль літери від кегля заголовка; drop — наскільки низ літери опускається під рядок (частка кегля заголовка);
// kern — відступ від літери до решти слова. Ті самі числа — у src/lib/photoSpec.ts (CAP)
export const CAP = { font: 'hand' as SpecFont, scale: 2, drop: 0.42, kern: 0.03 }
// Літери, які рукописом читаються першими (перевірка Buongiorno, Assets/round6/letters/README.md).
// Інша перша літера (Т Е Ґ Д Ф Х Ю Ї, цифра, лапки) — заголовок звичайний, заради літери не переписуємо
export const CAP_OK = new Set([...'АБВГЄЖЗИІЙКЛМНОПРСУЦЧШЩЯABCDHIJKLMNOPQUWYZ'])
export const capLetter = (text: string) => {
  const c = text.trimStart()[0]?.toUpperCase()
  return c && CAP_OK.has(c) ? c : null
}
// Коробка літери в рядку заголовка: базова лінія літери = базова лінія рядка + drop; від'ємний низ — щоб рядок не ставав вищим
// (одна відстань між рядками — правило Іри), літера просто звисає на наступний рядок
export function capBox(titleFont: SpecFont, size: number, lh: number) {
  const t = FONT[titleFont] ?? FONT.cormorant
  const c = FONT[CAP.font]
  const cs = Math.round(size * CAP.scale)
  const mt = Math.round(((lh - t.asc - t.desc) / 2 + t.asc) * size + CAP.drop * size - ((1 - c.asc - c.desc) / 2 + c.asc) * cs)
  return { size: cs, mt, mb: Math.round(size * lh) - mt - cs, mr: Math.round(CAP.kern * size) }
}
export const CREAM = '#F3EBDD'
export const GRAPH = '#2F2B27'
export const GOLD = '#C9B27C'
// Розрядка капсу (надпис «Країна · Готель») — як у старому textLayer
export const TRACK_UPPER = 0.16
// Одна відстань між блоками / абзацами — правило Іри: 16 px на 1080 (feedback 28.10–01.11)
export const GAP = 16 / 1080

let fonts: { name: string; data: Buffer; weight: 400 | 500; style: 'normal' }[] | null = null
export function loadFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), 'server', 'fonts')
    fonts = Object.entries(FONT).map(([k, f]) => {
      const raw = readFileSync(join(dir, f.file))
      return { name: f.name, data: k === 'cormorant' ? zeroWidth(raw) : raw, weight: f.weight, style: 'normal' as const }
    })
  }
  return fonts
}

// У Cormorant невидимі символи (word joiner, ZWJ, ZWSP…) мають ширину 0.6 em → «2–   4» з діркою.
// Обнуляємо їм ширину в копії шрифту: cmap формату 4 → номер гліфа → hmtx
function zeroWidth(src: Buffer): Buffer {
  const b = Buffer.from(src)
  const tables: Record<string, number> = {}
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) tables[b.toString('latin1', 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16)
  const cmap = tables.cmap
  let sub = -1
  for (let i = 0, n = b.readUInt16BE(cmap + 2); i < n; i++) {
    const at = cmap + 4 + i * 8
    const o = cmap + b.readUInt32BE(at + 4)
    if (b.readUInt16BE(o) === 4 && (b.readUInt16BE(at) === 3 || b.readUInt16BE(at) === 0)) { sub = o; break }
  }
  if (sub < 0) return b
  const seg = b.readUInt16BE(sub + 6) / 2
  const end = sub + 14
  const start = end + seg * 2 + 2
  const delta = start + seg * 2
  const range = delta + seg * 2
  const glyph = (c: number) => {
    for (let i = 0; i < seg; i++) {
      if (b.readUInt16BE(end + i * 2) < c) continue
      const s = b.readUInt16BE(start + i * 2)
      if (s > c) return 0
      const ro = b.readUInt16BE(range + i * 2)
      const g = ro ? b.readUInt16BE(range + i * 2 + ro + 2 * (c - s)) : c
      return g ? (g + b.readUInt16BE(delta + i * 2)) & 0xffff : 0
    }
    return 0
  }
  const metrics = b.readUInt16BE(tables.hhea + 34)
  for (const c of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
    const g = glyph(c)
    if (g && g < metrics) b.writeUInt16BE(0, tables.hmtx + g * 4)
  }
  return b
}

export type El = { type: string; props: Record<string, unknown> }
export const el = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } })

// Типографіка старого шляху (текст агента): «2–4» не рвемо (word joiner після тире), короткі слова («у», «на», «та», «з»)
// не висять у кінці рядка (нерозривний пробіл); \n — ручний перенос, типографіка по кожному рядку
const typo1 = (s: string) =>
  s.replace(/(\d)\s*([–—-])\s*(\d)/g, '$1$2⁠$3').replace(/(^|\s)(\p{L}{1,2})\s+(?=\S)/gu, '$1$2 ').replace(/(^|\s)(\p{L}{1,2})\s+(?=\S)/gu, '$1$2 ')
export const typo = (s: string) => s.split('\n').map(typo1).join('\n')

// Рядки блоку редактора → групи слів з наскрізним номером (gold — номери слів у всьому блоці, як VLine.gold у відео).
// Коротке слово (1–2 літери) склеюється з наступним у непереносну групу — та сама типографіка, що typo(), але номери слів не з'їжджають.
// Порожній рядок (абзац) — null: відступ GAP, а не цілий порожній рядок
export type Word = { text: string; n: number }
export function blockLines(text: string): (Word[][] | null)[] {
  let n = -1
  return text.split('\n').map((line) => {
    const ws = line.split(/\s+/).filter(Boolean)
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
export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length

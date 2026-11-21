import satori from 'satori'
import sharp from 'sharp'
import type { Zone } from './look.js'
import { blockLines, CREAM, el, FONT, GAP, GOLD, GRAPH, loadFonts, TRACK_UPPER, typo, type El, type SpecFont } from './typo.js'

// Текст на фото як у тесті раунду 7: по центру, поля 9%, зверху 8% / знизу 7%.
// Брендові шрифти (як у відео, src/lib/video.ts FONT): Cormorant Garamond — основний рядок, Tenor Sans капсом з розрядкою — готель / місце / інфо.
// Кремовий на затемненні, графітовий на світлій вуалі. Шрифти й типографіка — server/typo.ts (спільні з редактором Іри, сет 5)

// small — підпис на фото 2–10 каруселі: лише один рядок, дрібніше за заголовок обкладинки
export type PhotoText = { kicker?: string; title: string; small?: boolean }

// Прозорий PNG w×h з текстом — кладемо поверх фото (sharp composite)
// inset — додатковий відступ згори/знизу (сторіз: там лежать аватар і поле відповіді Instagram)
// opts — правки Іри: size (розмір рядка), width (поля з боків: wide — текст на всю ширину, narrow — вужчий стовпчик)
export async function textLayer(w: number, h: number, t: PhotoText, zone: Zone, frame: number, inset = 0, opts: { size?: 'bigger' | 'smaller'; width?: 'wide' | 'narrow' } = {}): Promise<Buffer> {
  const color = zone.text === 'light' ? CREAM : GRAPH
  const shadow = zone.text === 'light' ? '0 1px 3px rgba(0,0,0,0.45), 0 2px 18px rgba(0,0,0,0.45)' : 'none'
  const inner = w - 2 * frame
  // × 1.1 — Cormorant має менше очко, ніж був Prata (той самий scale, що у відео)
  const titleSize = Math.round(inner * (t.small ? 0.05 : t.title.length > 34 ? 0.058 : 0.068) * 1.1 * (opts.size === 'bigger' ? 1.2 : opts.size === 'smaller' ? 0.85 : 1))
  const side = opts.width === 'wide' ? 0.035 : opts.width === 'narrow' ? 0.18 : 0.09
  const kids: El[] = []
  if (t.kicker) {
    kids.push(el('div', {
      fontFamily: 'Tenor Sans', fontSize: Math.round(inner * 0.026), letterSpacing: '0.16em', textTransform: 'uppercase',
      marginBottom: Math.round(inner * 0.022), textShadow: shadow,
    }, t.kicker))
  }
  kids.push(el('div', { fontFamily: 'Cormorant Garamond', fontWeight: 500, fontSize: titleSize, lineHeight: 1.18, textShadow: shadow, whiteSpace: 'pre-line' }, typo(t.title)))

  const pad = zone.zone === 'top' ? { paddingTop: Math.round(frame + inset + (h - 2 * frame) * 0.08) } : { paddingBottom: Math.round(frame + inset + (h - 2 * frame) * 0.07) }
  const root = el('div', {
    width: w, height: h, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: zone.zone === 'top' ? 'flex-start' : 'flex-end',
    paddingLeft: Math.round(frame + inner * side), paddingRight: Math.round(frame + inner * side), ...pad,
    color, textAlign: 'center',
  }, kids)

  // satori приймає React-подібні вузли (JSX не потрібен) і віддає SVG з літерами-контурами → sharp рендерить без шрифтів у системі
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: w, height: h, fonts: loadFonts() })
  return sharp(Buffer.from(svg)).png().toBuffer()
}

// ───────────── Редактор Іри (сет 5): render_params.photo_spec[media_id] ─────────────
// Координати — частки фото без рамки (сторіз: без зон інтерфейсу Instagram), тож та сама спека працює в 4:5, Telegram і 9:16.
// x, y — центр блоку тексту; w — ширина блоку; size — кегль, частка ширини фото; lh — міжрядковий інтервал.
// veil: null — сила вуалі сама (від яскравості під текстом), число 0…0.85 — як поставила Іра. color: light — кремовий текст на затемненні,
// dark — графітовий на світлій вуалі. source: 'ira' — збережено Ірою, агент цей слайд ніколи не перегенеровує
export type SpecBlock = { role: 'kicker' | 'title'; text: string; font: SpecFont; size: number; lh: number; gold: number[]; cap?: 'upper' | null }
export type PhotoSpec = { v: 1; x: number; y: number; w: number; veil: number | null; color: 'light' | 'dark'; blocks: SpecBlock[]; source: 'ira' | 'ai' }

// Блок → вузли satori. Слова — flex-елементи з відступом рівно в пробіл (satori не вміє інлайн-спанів для золотих слів),
// той самий layout малює DOM-прев'ю в src/components/PhotoEditor.tsx
function specBlock(b: SpecBlock, unit: number, gap: number, color: string, shadow: string): El[] {
  const f = FONT[b.font] ?? FONT.cormorant
  const size = Math.max(8, Math.round(b.size * unit))
  const upper = !f.script && b.cap === 'upper'
  const track = upper ? TRACK_UPPER * size : 0
  const sp = f.space * size + track
  const gold = new Set(b.gold)
  const base = { fontFamily: f.name, fontWeight: f.weight, fontSize: size, lineHeight: b.lh, letterSpacing: track, textTransform: upper ? 'uppercase' : 'none', color, textShadow: shadow }
  const word = (w: { text: string; n: number }) => el('div', gold.has(w.n) ? { color: GOLD } : {}, w.text)
  return blockLines(b.text).map((groups) => groups === null
    ? el('div', { height: gap, width: 1 })
    : el('div', { ...base, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: sp, width: '100%' },
      groups.map((g) => (g.length === 1 ? word(g[0]) : el('div', { display: 'flex', columnGap: sp }, g.map(word))))))
}

// Прозорий PNG w×h зі спекою Іри; frame — біла рамка, inset — зони інтерфейсу згори/знизу (сторіз)
export async function specLayer(w: number, h: number, spec: PhotoSpec, frame: number, inset = 0): Promise<Buffer | null> {
  const blocks = spec.blocks.filter((b) => b.text.trim())
  if (!blocks.length) return null
  const iw = w - 2 * frame
  const ih = h - 2 * frame - 2 * inset
  const gap = Math.round(w * GAP)
  const color = spec.color === 'dark' ? GRAPH : CREAM
  const shadow = spec.color === 'dark' ? 'none' : '0 1px 3px rgba(0,0,0,0.45), 0 2px 18px rgba(0,0,0,0.45)'
  const cx = frame + spec.x * iw
  const cy = frame + inset + spec.y * ih
  const kids: El[] = []
  blocks.forEach((b, i) => {
    if (i) kids.push(el('div', { height: gap, width: 1 }))
    kids.push(...specBlock(b, iw, gap, color, shadow))
  })
  // Центр блоку — у (cx, cy): падінг з одного боку = 2·c − розмір, flex центрує в решті (як обкладинка відео, textPng centerY)
  const root = el('div', {
    width: w, height: h, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
    paddingTop: Math.max(0, 2 * cy - h), paddingBottom: Math.max(0, h - 2 * cy), paddingLeft: Math.max(0, 2 * cx - w), paddingRight: Math.max(0, w - 2 * cx),
  }, [el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', width: Math.round(spec.w * iw), textAlign: 'center' }, kids)])
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: w, height: h, fonts: loadFonts() })
  return sharp(Buffer.from(svg)).png().toBuffer()
}

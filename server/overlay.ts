import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import sharp from 'sharp'
import type { Zone } from './look.js'

// Текст на фото як у тесті раунду 7: по центру, поля 9%, зверху 8% / знизу 7%.
// Брендові шрифти (як у відео, src/lib/video.ts FONT): Cormorant Garamond — основний рядок, Tenor Sans капсом з розрядкою — готель / місце / інфо.
// Кремовий на затемненні, графітовий на світлій вуалі. Buongiorno не купили → рукописної літери немає
const CREAM = '#F3EBDD'
const GRAPH = '#2F2B27'

let fonts: { name: string; data: Buffer; weight: 400 | 500; style: 'normal' }[] | null = null
export function loadFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), 'server', 'fonts')
    fonts = [
      { name: 'Cormorant Garamond', data: zeroWidth(readFileSync(join(dir, 'CormorantGaramond-Medium.ttf'))), weight: 500, style: 'normal' },
      { name: 'Tenor Sans', data: readFileSync(join(dir, 'TenorSans-Regular.ttf')), weight: 400, style: 'normal' },
    ]
  }
  return fonts
}

// У Cormorant невидимі символи (word joiner з typo(), ZWJ, ZWSP…) мають ширину 0.6 em → «2–   4» з діркою.
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

// small — підпис на фото 2–10 каруселі: лише один рядок, дрібніше за заголовок обкладинки
export type PhotoText = { kicker?: string; title: string; small?: boolean }

// Типографіка заголовка: «2–4» не рвемо (word joiner після тире), короткі слова («у», «на», «та», «з») не висять у кінці рядка (нерозривний пробіл)
const typo = (s: string) =>
  s.replace(/(\d)\s*([–—-])\s*(\d)/g, '$1$2\u2060$3').replace(/(^|\s)(\p{L}{1,2})\s+(?=\S)/gu, '$1$2\u00A0').replace(/(^|\s)(\p{L}{1,2})\s+(?=\S)/gu, '$1$2\u00A0')

type El = { type: string; props: Record<string, unknown> }
const el = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } })

// Прозорий PNG w×h з текстом — кладемо поверх фото (sharp composite)
// inset — додатковий відступ згори/знизу (сторіз: там лежать аватар і поле відповіді Instagram)
export async function textLayer(w: number, h: number, t: PhotoText, zone: Zone, frame: number, inset = 0): Promise<Buffer> {
  const color = zone.text === 'light' ? CREAM : GRAPH
  const shadow = zone.text === 'light' ? '0 1px 3px rgba(0,0,0,0.45), 0 2px 18px rgba(0,0,0,0.45)' : 'none'
  const inner = w - 2 * frame
  // × 1.1 — Cormorant має менше очко, ніж був Prata (той самий scale, що у відео)
  const titleSize = Math.round(inner * (t.small ? 0.05 : t.title.length > 34 ? 0.058 : 0.068) * 1.1)
  const kids: El[] = []
  if (t.kicker) {
    kids.push(el('div', {
      fontFamily: 'Tenor Sans', fontSize: Math.round(inner * 0.026), letterSpacing: '0.16em', textTransform: 'uppercase',
      marginBottom: Math.round(inner * 0.022), textShadow: shadow,
    }, t.kicker))
  }
  kids.push(el('div', { fontFamily: 'Cormorant Garamond', fontWeight: 500, fontSize: titleSize, lineHeight: 1.18, textShadow: shadow }, typo(t.title)))

  const pad = zone.zone === 'top' ? { paddingTop: Math.round(frame + inset + (h - 2 * frame) * 0.08) } : { paddingBottom: Math.round(frame + inset + (h - 2 * frame) * 0.07) }
  const root = el('div', {
    width: w, height: h, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: zone.zone === 'top' ? 'flex-start' : 'flex-end',
    paddingLeft: Math.round(frame + inner * 0.09), paddingRight: Math.round(frame + inner * 0.09), ...pad,
    color, textAlign: 'center',
  }, kids)

  // satori приймає React-подібні вузли (JSX не потрібен) і віддає SVG з літерами-контурами → sharp рендерить без шрифтів у системі
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: w, height: h, fonts: loadFonts() })
  return sharp(Buffer.from(svg)).png().toBuffer()
}

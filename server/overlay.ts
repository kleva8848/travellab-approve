import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import sharp from 'sharp'
import type { Zone } from './look.js'

// Текст на фото як у тесті раунду 7: по центру, поля 9%, зверху 8% / знизу 7%.
// Шрифти затверджені: Prata — основний рядок, Tenor Sans капсом з розрядкою — готель / місце / інфо.
// Кремовий на затемненні, графітовий на світлій вуалі. Buongiorno не купили → рукописної літери немає
const CREAM = '#F3EBDD'
const GRAPH = '#2F2B27'

let fonts: { name: string; data: Buffer; weight: 400; style: 'normal' }[] | null = null
function loadFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), 'server', 'fonts')
    fonts = [
      { name: 'Prata', data: readFileSync(join(dir, 'Prata-Regular.ttf')), weight: 400, style: 'normal' },
      { name: 'Tenor Sans', data: readFileSync(join(dir, 'TenorSans-Regular.ttf')), weight: 400, style: 'normal' },
    ]
  }
  return fonts
}

export type PhotoText = { kicker?: string; title: string }

type El = { type: string; props: Record<string, unknown> }
const el = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } })

// Прозорий PNG w×h з текстом — кладемо поверх фото (sharp composite)
export async function textLayer(w: number, h: number, t: PhotoText, zone: Zone, frame: number): Promise<Buffer> {
  const color = zone.text === 'light' ? CREAM : GRAPH
  const shadow = zone.text === 'light' ? '0 2px 18px rgba(0,0,0,0.35)' : 'none'
  const inner = w - 2 * frame
  const titleSize = Math.round(inner * (t.title.length > 34 ? 0.058 : 0.068))
  const kids: El[] = []
  if (t.kicker) {
    kids.push(el('div', {
      fontFamily: 'Tenor Sans', fontSize: Math.round(inner * 0.026), letterSpacing: '0.16em', textTransform: 'uppercase',
      marginBottom: Math.round(inner * 0.022), textShadow: shadow,
    }, t.kicker))
  }
  kids.push(el('div', { fontFamily: 'Prata', fontSize: titleSize, lineHeight: 1.22, textShadow: shadow }, t.title))

  const pad = zone.zone === 'top' ? { paddingTop: Math.round(frame + (h - 2 * frame) * 0.08) } : { paddingBottom: Math.round(frame + (h - 2 * frame) * 0.07) }
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

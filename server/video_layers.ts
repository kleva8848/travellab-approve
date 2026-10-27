import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import sharp from 'sharp'
import type { Plan } from './video.js'

// Фінальний рендер сторіз / рілс (сет 3): шари плану → прозорі PNG 1080×1920, які воркер кладе на clean.mp4 (ffmpeg overlay + fade).
// Layout — копія прев'ю (src/components/VideoScreen.tsx: TextBlock / Line / Watermark), константи — з src/lib/video.ts.
// Без відносних імпортів (лише `import type`): воркер запускає цей файл напряму через node (scripts/video_layers.mjs).

const VW = 1080
const VH = 1920
const SAFE_TOP = 250
const SAFE_BOTTOM = VH - 340
const GOLD = '#C9B27C'
const FADE = 0.45
const SUB_FADE = 0.12   // субтитри голосу (сет 6) — швидко, щоб встигали за мовою

const STYLES: Record<string, { font: string; size: number; gold: boolean; gap: number; track: number; upper: boolean }> = {
  hook: { font: 'cormorant', size: 84, gold: false, gap: 14, track: 0, upper: false },
  title: { font: 'cormorant', size: 70, gold: false, gap: 12, track: 0, upper: false },
  word: { font: 'cormorant', size: 120, gold: false, gap: 10, track: 6, upper: false },
  num: { font: 'tenor', size: 110, gold: true, gap: 6, track: 4, upper: false },
  sub: { font: 'tenor', size: 46, gold: false, gap: 12, track: 1, upper: false },
  label: { font: 'tenor', size: 38, gold: true, gap: 10, track: 7, upper: true },
}
// Брендові шрифти — як FONT у src/lib/video.ts (hand = Marck Script, тимчасова заміна Buongiorno Rastellino)
const FONT: Record<string, { name: string; file: string; weight: 400 | 500; lh: number; scale: number; script: boolean }> = {
  cormorant: { name: 'Cormorant Garamond', file: 'CormorantGaramond-Medium.ttf', weight: 500, lh: 1.308, scale: 1.1, script: false },
  tenor: { name: 'Tenor Sans', file: 'TenorSans-Regular.ttf', weight: 400, lh: 1.264, scale: 1, script: false },
  hand: { name: 'Marck Script', file: 'MarckScript-Regular.ttf', weight: 400, lh: 1.349, scale: 1.15, script: true },
}
const WM: Record<string, { w: number; h: number }> = { wm2: { w: 150, h: 150 }, wm1: { w: 330, h: 110 }, wm3: { w: 225, h: 150 } }

const dir = (sub: string) => fileURLToPath(new URL(`./${sub}/`, import.meta.url))

let fonts: { name: string; data: Buffer; weight: 400 | 500; style: 'normal' }[] | null = null
function loadFonts() {
  fonts ??= Object.values(FONT).map((f) => ({ name: f.name, data: readFileSync(dir('fonts') + f.file), weight: f.weight, style: 'normal' as const }))
  return fonts
}

// Ширина пробілу (частка кегля) з TTF: cmap формат 4 → гліф U+0020 → hmtx. Потрібна для рядків із золотими словами
function spaceEm(b: Buffer): number {
  const tables = new Map<string, number>()
  for (let i = 0; i < b.readUInt16BE(4); i++) tables.set(b.toString('latin1', 12 + 16 * i, 16 + 16 * i), b.readUInt32BE(20 + 16 * i))
  const head = tables.get('head')!, hhea = tables.get('hhea')!, hmtx = tables.get('hmtx')!, cmap = tables.get('cmap')!
  let gid = 0
  for (let i = 0; i < b.readUInt16BE(cmap + 2) && !gid; i++) {
    const st = cmap + b.readUInt32BE(cmap + 8 + 8 * i)
    if (b.readUInt16BE(cmap + 4 + 8 * i) !== 3 || b.readUInt16BE(st) !== 4) continue
    const seg = b.readUInt16BE(st + 6) / 2
    const ends = st + 14, starts = ends + 2 * seg + 2, deltas = starts + 2 * seg, ranges = deltas + 2 * seg
    for (let k = 0; k < seg; k++) {
      if (b.readUInt16BE(ends + 2 * k) < 0x20) continue
      if (b.readUInt16BE(starts + 2 * k) > 0x20) break
      const ro = b.readUInt16BE(ranges + 2 * k)
      const g = ro ? b.readUInt16BE(ranges + 2 * k + ro + 2 * (0x20 - b.readUInt16BE(starts + 2 * k))) : 0x20
      gid = (g + (ro ? 0 : b.readInt16BE(deltas + 2 * k))) & 0xffff
      break
    }
  }
  const n = b.readUInt16BE(hhea + 34)
  return b.readUInt16BE(hmtx + 4 * Math.min(gid, n - 1)) / b.readUInt16BE(head + 18)
}
let spaces: Record<string, number> | null = null
const space = (font: string) => (spaces ??= Object.fromEntries(loadFonts().map((f) => [f.name, spaceEm(f.data)])))[font] ?? 0.25

type El = { type: string; props: Record<string, unknown> }
const el = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } })

type Shot = { t0: number; t1: number }
type VText = Plan['texts'][number]
type VLine = VText['lines'][number]

// Коли текст видно — як textTimes() у src/lib/video.ts; субтитр голосу (sec) — за секундами
export function textTimes(shots: Shot[], dur: number, t: VText) {
  if (t.sec) return { t0: t.sec[0], t1: Math.min(dur, t.sec[1]) }
  const last = shots.length - 1
  const from = Math.min(t.from, last)
  const t0 = from === 0 ? 0.2 : shots[from].t0 + 0.4
  const t1 = t.to >= last ? dur : shots[t.to + 1].t0 + 0.1
  return { t0, t1 }
}

// Рядок без золота — один текстовий вузол (satori переносить слова так само, як браузер).
// Із золотими словами satori не вміє інлайн-спани → слова flex-елементами з відступом рівно в пробіл (+ розрядка);
// на початку рядка відступу немає — як браузер «з'їдає» пробіл на переносі
function line(l: VLine, gap: number): El {
  const st = STYLES[l.style] ?? STYLES.sub
  const f = FONT[l.font ?? ''] ?? FONT[st.font]
  const size = Math.round(st.size * f.scale)
  const track = f.script ? 0 : st.track
  const words = l.text.split(/\s+/).filter(Boolean)
  const base = {
    marginTop: gap, width: Math.min(l.maxW ?? 900, 900),
    fontFamily: f.name, fontWeight: f.weight, fontSize: size, lineHeight: f.lh, letterSpacing: track,
    textTransform: !f.script && st.upper ? 'uppercase' : 'none', color: st.gold ? GOLD : '#fff',
    textShadow: '0 4px 7px rgba(0,0,0,0.75)',
  }
  if (!l.gold.length) return el('div', { ...base, display: 'flex', justifyContent: 'center', textAlign: 'center' }, words.join(' '))
  const gold = new Set(l.gold)
  return el('div', { ...base, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: space(f.name) * size + track },
    words.map((w, i) => el('div', gold.has(i) ? { color: GOLD } : {}, w)))
}

const lineGap = (prev: VLine | undefined, l: VLine) => (!prev ? 0 : prev.style === l.style ? 4 : (STYLES[l.style] ?? STYLES.sub).gap * 2)

// Один текст → PNG на весь кадр: смуга затемнення ±150px на всю ширину + рядки по центру (ширина 900, відступ 90)
async function textPng(t: VText): Promise<Buffer> {
  const a = t.scrim
  const fade = (dirTo: 'bottom' | 'top') => el('div', {
    width: VW, height: 150,
    ...(a > 0 ? { backgroundImage: `linear-gradient(to ${dirTo}, rgba(0,0,0,0) 0%, rgba(0,0,0,${a * 0.35}) 50%, rgba(0,0,0,${a}) 100%)` } : {}),
  })
  const body = el('div', {
    display: 'flex', flexDirection: 'column', alignItems: 'center', width: VW, paddingLeft: 90, paddingRight: 90,
    ...(a > 0 ? { backgroundColor: `rgba(0,0,0,${a})` } : {}),
  }, t.lines.map((l, i) => line(l, lineGap(t.lines[i - 1], l))))
  const root = el('div', { display: 'flex', width: VW, height: VH, position: 'relative' }, [
    el('div', { position: 'absolute', left: 0, top: t.y - 150, display: 'flex', flexDirection: 'column', width: VW }, [fade('bottom'), body, fade('top')]),
  ])
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: VW, height: VH, fonts: loadFonts() })
  return sharp(Buffer.from(svg)).png().toBuffer()
}

// Знак як у прев'ю: білий (brightness(0) invert(1)) або свій золотий, drop-shadow(0 2px 4px rgba(0,0,0,.6)), opacity .88
async function wmPng(kind: string, pos: string, color: string): Promise<Buffer | null> {
  const box = WM[kind]
  if (!box) return null
  const { w, h } = box
  const x = pos === 'br' || pos === 'tr' ? VW - 70 - w : 70
  const y = pos === 'br' || pos === 'bl' ? SAFE_BOTTOM - 30 - h : SAFE_TOP + 30
  const img = await sharp(dir('watermarks') + `${kind}.png`)
    .resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer()
  const P = 10
  const W2 = w + 2 * P
  const H2 = h + 2 * P
  // тінь: альфа знака, зсув на 2px вниз, розмиття σ=2 (CSS blur 4px)
  const alpha = Buffer.alloc(W2 * H2)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const yy = j + P + 2
    if (yy < H2) alpha[yy * W2 + i + P] = img[(j * w + i) * 4 + 3]
  }
  const sh = await sharp(alpha, { raw: { width: W2, height: H2, channels: 1 } }).blur(2).extractChannel(0).raw().toBuffer()  // extractChannel — інакше sharp віддає 3 канали → смуги
  const out = Buffer.alloc(W2 * H2 * 4)
  for (let j = 0; j < H2; j++) for (let i = 0; i < W2; i++) {
    const o = (j * W2 + i) * 4
    const sa = (sh[j * W2 + i] / 255) * 0.6
    const fi = i - P
    const fj = j - P
    let fa = 0
    let rgb = [0, 0, 0]
    if (fi >= 0 && fi < w && fj >= 0 && fj < h) {
      const k = (fj * w + fi) * 4
      fa = img[k + 3] / 255
      rgb = color === 'gold' ? [img[k], img[k + 1], img[k + 2]] : [255, 255, 255]
    }
    const oa = fa + sa * (1 - fa)
    if (oa <= 0) continue
    out[o] = Math.round((rgb[0] * fa) / oa)
    out[o + 1] = Math.round((rgb[1] * fa) / oa)
    out[o + 2] = Math.round((rgb[2] * fa) / oa)
    out[o + 3] = Math.round(oa * 0.88 * 255)
  }
  return sharp({ create: { width: VW, height: VH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: out, raw: { width: W2, height: H2, channels: 4 }, left: x - P, top: y - P }]).png().toBuffer()
}

export type Layer = { png: Buffer; t0: number; t1: number; fadeIn: number; fadeOut: number | null }

// План → шари з часом: fade-in з t0 за 0.45 с, fade-out до t1 (на останньому кадрі — без зникнення, як у прев'ю)
export async function videoLayers(plan: Plan, shots: Shot[], dur: number): Promise<{ texts: Layer[]; wm: Buffer | null }> {
  const texts: Layer[] = []
  for (const t of plan.texts ?? []) {
    if (!t.lines?.length) continue
    const { t0, t1 } = textTimes(shots, dur, t)
    const f = t.sec ? SUB_FADE : FADE
    texts.push({ png: await textPng(t), t0, t1, fadeIn: f, fadeOut: t1 >= dur - 0.05 ? null : Math.max(t0, t1 - f) })
  }
  const w = plan.wm ?? { kind: 'wm2', pos: 'br', color: 'white' }
  return { texts, wm: w.kind === 'off' ? null : await wmPng(w.kind, w.pos, w.color) }
}

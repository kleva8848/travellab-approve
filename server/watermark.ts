import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import satori from 'satori'
import sharp from 'sharp'
import { getSettings } from './http.js'
import { loadFonts } from './overlay.js'

// Водяні знаки Іри (план §17), шампань-золото, на кожне фото:
// wm1 — горизонтальний «TRAVEL LAB ─✦─ PRIVATE TRAVEL CONCIERGE» (обкладинки / знайомство)
// wm2 — коло «TRAVEL LAB · PRIVATE TRAVEL CONCIERGE» із зіркою-компасом у центрі (сторіз / рілс)
// wm3 — «Travel Lab» + зірка + «PRIVATE TRAVEL CONCIERGE» (пост / карусель), дрібно в куті навпроти тексту
// Оригінали PNG з прозорим фоном кладуться в server/watermarks/wm1.png, wm2.png, wm3.png — код не міняється.
// Поки файлу нема — малюємо імітацію тими ж шрифтами (заглушка).
// Вмикається в settings: watermark = "on" (дефолт — вимкнено, щоб Іра не побачила заглушку)
export type WmKind = 'wm1' | 'wm2' | 'wm3'

const GOLD = '#C9B27C'
// Ширина знака від меншої сторони кадру
const SIZE: Record<WmKind, number> = { wm1: 0.42, wm2: 0.2, wm3: 0.18 }
const STUB_REV = 's1' // змінили вигляд заглушки → новий кеш

const dir = () => join(process.cwd(), 'server', 'watermarks')
const fileOf = (k: WmKind) => join(dir(), `${k}.png`)

// Позначка в назві готового файлу: '' — знаки вимкнені (старий кеш лишається валідним),
// інакше 'w' + відбиток джерел (поклали справжні PNG замість заглушки → фото перемалюються)
let print: string | null = null
export async function watermarkTag(): Promise<string> {
  let on = false
  try {
    const s = await getSettings(['watermark'])
    on = s.watermark === 'on' || s.watermark === true
  } catch {
    on = false
  }
  if (!on) return ''
  if (print === null) {
    const h = createHash('sha1').update(STUB_REV)
    for (const k of ['wm1', 'wm2', 'wm3'] as const) h.update(existsSync(fileOf(k)) ? readFileSync(fileOf(k)) : `${k}:stub`)
    print = 'w' + h.digest('hex').slice(0, 4)
  }
  return print
}

// Зірка-компас: 4 довгі промені, 4 короткі діагональні
function starSvg(color = GOLD): string {
  const pts: string[] = []
  for (let k = 0; k < 16; k++) {
    const r = k % 4 === 0 ? 48 : k % 2 === 0 ? 20 : 6
    const a = (k * 22.5 * Math.PI) / 180
    pts.push(`${(50 + r * Math.sin(a)).toFixed(2)},${(50 - r * Math.cos(a)).toFixed(2)}`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="${pts.join(' ')}" fill="${color}"/></svg>`
}
const starUrl = () => `data:image/svg+xml;base64,${Buffer.from(starSvg()).toString('base64')}`

type El = { type: string; props: Record<string, unknown> }
const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): El => ({ type, props: { style, children, ...extra } })
const star = (s: number, style: Record<string, unknown> = {}) => el('img', { width: s, height: s, ...style }, undefined, { src: starUrl(), width: s, height: s })
const caps = (text: string, size: number, spacing = '0.18em', style: Record<string, unknown> = {}) =>
  el('div', { fontFamily: 'Tenor Sans', fontSize: size, letterSpacing: spacing, textTransform: 'uppercase', ...style }, text)

// Заглушка-імітація: макет у 600 px завширшки, далі обрізаємо прозорі поля
function stubLayout(k: WmKind): { root: El; w: number; h: number } {
  const W = 600
  if (k === 'wm1') {
    const line = el('div', { width: 46, height: 2, background: GOLD })
    const root = el('div', { width: W * 2, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: GOLD }, [
      caps('Travel Lab', 44, '0.22em'),
      el('div', { display: 'flex', alignItems: 'center', margin: '0 22px' }, [line, star(40, { margin: '0 10px' }), line]),
      caps('Private Travel Concierge', 26, '0.2em'),
    ])
    return { root, w: W * 2, h: 120 }
  }
  if (k === 'wm2') {
    const D = W
    const r = D * 0.4
    const fs = 40
    const text = 'TRAVEL LAB · PRIVATE TRAVEL CONCIERGE · '
    const step = 360 / text.length
    const letters = [...text].map((ch, i) => {
      const a = i * step
      const rad = (a * Math.PI) / 180
      const x = D / 2 + r * Math.sin(rad)
      const y = D / 2 - r * Math.cos(rad)
      return el('div', {
        position: 'absolute', left: x - fs / 2, top: y - fs / 2, width: fs, height: fs, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Tenor Sans', fontSize: fs, transform: `rotate(${a}deg)`,
      }, ch === ' ' ? ' ' : ch)
    })
    const ring = (rr: number) => el('div', { position: 'absolute', left: D / 2 - rr, top: D / 2 - rr, width: rr * 2, height: rr * 2, borderRadius: rr, border: `2px solid ${GOLD}` })
    const root = el('div', { width: D, height: D, display: 'flex', position: 'relative', color: GOLD }, [
      ring(r + fs * 0.75), ring(r - fs * 0.75), ...letters,
      star(D * 0.34, { position: 'absolute', left: D * 0.33, top: D * 0.33 }),
    ])
    return { root, w: D, h: D }
  }
  const root = el('div', { width: W * 1.5, height: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: GOLD }, [
    el('div', { display: 'flex', alignItems: 'flex-start' }, [
      el('div', { fontFamily: 'Prata', fontSize: 104, lineHeight: 1 }, 'Travel Lab'),
      star(40, { marginLeft: 10, marginTop: -6 }),
    ]),
    caps('Private Travel Concierge', 27, '0.2em', { marginTop: 14 }),
  ])
  return { root, w: W * 1.5, h: 260 }
}

const marks = new Map<WmKind, Buffer>()
async function mark(k: WmKind): Promise<Buffer> {
  const hit = marks.get(k)
  if (hit) return hit
  let png: Buffer
  if (existsSync(fileOf(k))) png = readFileSync(fileOf(k))
  else {
    const { root, w, h } = stubLayout(k)
    const svg = await satori(root as unknown as Parameters<typeof satori>[0], { width: w, height: h, fonts: loadFonts() })
    png = await sharp(Buffer.from(svg)).png().toBuffer()
  }
  // прозорі поля навколо не рахуємо в розмір
  const out = await sharp(png).ensureAlpha().trim({ threshold: 1 }).png().toBuffer().catch(() => sharp(png).ensureAlpha().png().toBuffer())
  marks.set(k, out)
  return out
}

// Наскільки «зайнятий» прямокутник (деталі, люди, текстура) — знак кладемо в спокійніший кут
function busy(g: Buffer, gw: number, x0: number, y0: number, w: number, h: number): number {
  let s = 0, s2 = 0, e = 0, n = 0
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const v = g[y * gw + x]
      s += v; s2 += v * v; n++
      if (x > x0) e += Math.abs(v - g[y * gw + x - 1])
    }
  }
  if (!n) return 0
  const m = s / n
  return Math.sqrt(Math.max(0, s2 / n - m * m)) + (2 * e) / n
}

// Де по горизонталі (0..1) «головне» у верхній / нижній половині кадру
async function focusX(img: Buffer, w: number, h: number, half: 'top' | 'bottom'): Promise<number> {
  const hh = Math.floor(h / 2)
  const band = await sharp(img).extract({ left: 0, top: half === 'top' ? 0 : h - hh, width: w, height: hh }).resize({ width: 300 }).png().toBuffer({ resolveWithObject: true })
  const win = 120
  const r = await sharp(band.data).resize(win, band.info.height, { fit: 'cover', position: sharp.strategy.attention }).toBuffer({ resolveWithObject: true })
  const info = r.info as { cropOffsetLeft?: number; attentionX?: number }
  if (info.attentionX) return info.attentionX / 300
  return (Math.abs(info.cropOffsetLeft ?? 90) + win / 2) / 300
}

// Кладе знак у кут, протилежний тексту (текст угорі → знак унизу і навпаки), з легкою тінню.
// inset — зона інтерфейсу згори/знизу (сторіз), pad — біла рамка
export async function addWatermark(img: Buffer, k: WmKind, textZone: 'top' | 'bottom' | null, pad: number, inset = 0): Promise<Buffer> {
  const meta = await sharp(img).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  const base = Math.min(w, h)
  const mw = Math.round(base * SIZE[k])
  const m = await sharp(await mark(k)).resize({ width: mw }).png().toBuffer({ resolveWithObject: true })
  const mh = m.info.height
  const gap = pad + Math.round(base * 0.035)
  const ys = textZone === 'bottom' ? [gap + inset] : [h - gap - inset - mh]
  const xs = [w - gap - mw, gap] // спершу правий кут: за рівності лишається він
  // сірий зменшений кадр для оцінки кутів
  const S = 4
  const gw = Math.max(1, Math.round(w / S))
  const gh = Math.max(1, Math.round(h / S))
  const grey = await sharp(img).resize(gw, gh, { fit: 'fill' }).greyscale().raw().toBuffer()
  let best = { x: xs[1], y: ys[0], score: Infinity }
  for (const y of ys) {
    for (const x of xs) {
      const score = busy(grey, gw, Math.floor(x / S), Math.floor(y / S), Math.max(1, Math.floor(mw / S)), Math.max(1, Math.floor(mh / S))) * (x === xs[1] ? 1.08 : 1)
      if (score < best.score) best = { x, y, score }
    }
  }
  // Люди: «головне» в половині кадру зі знаком (sharp attention — шкіра, насиченість, контраст).
  // Якщо воно близько до одного з кутів — знак у дальній кут, незалежно від «спокою»
  const focus = await focusX(img, w, h, ys[0] < h / 2 ? 'top' : 'bottom').catch(() => null)
  if (focus !== null) {
    const dist = xs.map((x) => Math.abs((x + mw / 2) / w - focus))
    if (Math.min(...dist) < 0.3) best.x = dist[0] > dist[1] ? xs[0] : xs[1]
  }
  // тінь: альфа знака, розмита, чорна ~55%
  const blur = Math.max(1, Math.round(mw * 0.015))
  const e = blur * 3
  const alpha = await sharp(m.data).extractChannel(3).raw().toBuffer()
  const rgba = Buffer.alloc(mw * mh * 4)
  for (let i = 0; i < mw * mh; i++) rgba[i * 4 + 3] = Math.round(alpha[i] * 0.55)
  const shadow = await sharp(rgba, { raw: { width: mw, height: mh, channels: 4 } })
    .extend({ top: e, bottom: e, left: e, right: e, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(blur)
    .png()
    .toBuffer()
  return sharp(img)
    .composite([
      { input: shadow, left: Math.max(0, best.x - e), top: Math.max(0, best.y - e + 1) },
      { input: m.data, left: best.x, top: best.y },
    ])
    .png()
    .toBuffer()
}

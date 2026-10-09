import sharp from 'sharp'

// Порт `look.py` (round6/treatment, режими soft / calm_zone / veil від 08.10) на sharp — щоб рендер жив на Vercel без Python.
// soft: міняємо лише яскравість, кожен піксель × Ynew/Y → відтінок і насиченість як в оригіналі (Іра: «обробка спотворює»)
// veil: м'яке нейтральне затемнення лише від краю з текстом; на світлій зоні — ледь світла вуаль

const lum = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722
const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function percentile(sorted: Float32Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
}

export type Zone = { zone: 'top' | 'bottom'; text: 'light' | 'dark'; source: 'hint' | 'auto' }

// Де класти текст: верх чи низ (спокійніший = менше дрібних деталей). hint від Vision (де нема людей) має пріоритет
export async function calmZone(img: Buffer, hint?: string | null, frac = 0.42): Promise<Zone> {
  const { data, info } = await sharp(img).resize({ width: 400 }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const n = Math.floor(h * frac)
  const busy = (y0: number, y1: number) => {
    let s = 0, s2 = 0, gx = 0, gy = 0, cnt = 0, cx = 0, cy = 0
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x] / 255
        s += v; s2 += v * v; cnt++
        if (x > 0) { gx += Math.abs(v - data[y * w + x - 1] / 255); cx++ }
        if (y > y0) { gy += Math.abs(v - data[(y - 1) * w + x] / 255); cy++ }
      }
    }
    const mean = s / cnt
    return Math.sqrt(Math.max(0, s2 / cnt - mean * mean)) + 4 * (gx / cx + gy / cy)
  }
  const median = (y0: number, y1: number) => {
    const a = Float32Array.from(data.subarray(y0 * w, y1 * w)).sort()
    return a[a.length >> 1]
  }
  const zone = hint === 'top' || hint === 'bottom' ? hint : busy(0, n) < busy(h - n, h) * 0.9 ? 'top' : 'bottom'
  const L = zone === 'top' ? median(0, n) : median(h - n, h)
  return { zone, text: L > 165 ? 'dark' : 'light', source: hint === 'top' || hint === 'bottom' ? 'hint' : 'auto' }
}

// Рядки, де реально лежить текст (у координатах фото без рамки) — щоб вуаль покривала весь заголовок, а не лише край
export type Band = { y0: number; y1: number }

// Raw RGB уже потрібного розміру → soft (+ veil, якщо є зона тексту). Повертає raw RGB того ж розміру.
// З band: під текстом вуаль на повну силу, а сила — від яскравості фото саме під текстом (біла піна / пісок / небо
// під кремовим текстом → темніше, до 70%); далі м'яко сходить до центру кадру
export function softVeil(rgb: Buffer, w: number, h: number, zone?: Zone | null, strength = 0.42, frac = 0.36, band?: Band | null): Buffer {
  const px = w * h
  const y = new Float32Array(px)
  for (let i = 0; i < px; i++) y[i] = lum(rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255)
  const sorted = Float32Array.from(y).sort()
  const med = percentile(sorted, 50)

  let g = 1
  if (med < 0.32 || med > 0.58) { // лише явно темні / явно світлі кадри
    const target = med < 0.32 ? 0.36 : 0.52
    g = Math.log(target) / Math.log(Math.min(0.95, Math.max(0.05, med)))
    g = Math.min(1.2, Math.max(0.8, g))
    g = 1 + (g - 1) * 0.6 // пів шляху, не до цілі
  }
  let hot = 0
  for (let i = 0; i < px; i++) if (y[i] > 0.97) hot++
  if (hot / px > 0.02) g = Math.max(g, 0.97) // сонце в кадрі не роздуваємо
  const lift = Math.min(Math.max(percentile(sorted, 0.5) - 0.04, 0), 0.06) * 0.5 // серпанок — половину, не більше 3%

  const tone = (yi: number) => Math.pow(Math.min(1, Math.max(0, (yi - lift) / (1 - lift))), g)
  let weight = (row: number) => {
    const t = h > 1 ? row / (h - 1) : 0
    return smooth(zone!.zone === 'top' ? 1 - t : t, 1 - frac, 1) // 1 біля краю з текстом
  }
  if (zone && band) {
    const margin = Math.round(h * 0.05)
    const feather = Math.round(h * 0.22)
    const y0 = Math.max(0, band.y0 - margin)
    const y1 = Math.min(h - 1, band.y1 + margin)
    // світлі місця під текстом (p85 яскравості після soft) — їх і треба приглушити, середнє тут бреше
    const under: number[] = []
    for (let row = y0; row <= y1; row += 2) for (let col = 0; col < w; col += 2) under.push(tone(y[row * w + col]))
    under.sort((a, b) => a - b)
    const hi = under.length ? under[Math.floor(under.length * 0.85)] : 0
    if (zone.text === 'light') strength = Math.min(0.7, Math.max(strength, 1 - 0.4 / Math.max(hi, 1e-3)))
    else strength = Math.min(0.75, Math.max(strength, hi < 0.6 ? (0.6 - hi) / (0.45 * (1 - hi)) : 0))
    weight = (row: number) =>
      zone.zone === 'top' ? (row <= y1 ? 1 : 1 - smooth(row, y1, y1 + feather)) : row >= y0 ? 1 : smooth(row, y0 - feather, y0)
  }

  const out = Buffer.alloc(px * 3)
  for (let row = 0; row < h; row++) {
    const m = zone ? weight(row) * strength : 0
    for (let col = 0; col < w; col++) {
      const i = row * w + col
      const yi = y[i]
      const yn = tone(yi)
      const k = yn / Math.max(yi, 1e-4)
      let r = (rgb[i * 3] / 255) * k
      let gg = (rgb[i * 3 + 1] / 255) * k
      let b = (rgb[i * 3 + 2] / 255) * k
      const mx = Math.max(r, gg, b, 1) // пересвіт стискаємо пропорційно, щоб не зсунути відтінок
      r /= mx; gg /= mx; b /= mx
      if (m > 0) {
        if (zone!.text === 'light') { r *= 1 - m; gg *= 1 - m; b *= 1 - m } // нейтральне затемнення
        else { r += (1 - r) * m * 0.45; gg += (1 - gg) * m * 0.45; b += (1 - b) * m * 0.45 }
      }
      const dz = () => Math.random() - 0.5 // дизер проти бандингу на градієнті
      out[i * 3] = Math.min(255, Math.max(0, Math.round(r * 255 + dz())))
      out[i * 3 + 1] = Math.min(255, Math.max(0, Math.round(gg * 255 + dz())))
      out[i * 3 + 2] = Math.min(255, Math.max(0, Math.round(b * 255 + dz())))
    }
  }
  return out
}

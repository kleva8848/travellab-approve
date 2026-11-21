import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { db, getSettings } from './http.js'
import { calmZone, softVeil, type Band, type Zone } from './look.js'
import { specLayer, textLayer, type PhotoSpec, type PhotoText, type SpecBlock } from './overlay.js'
import { FONT, wordCount } from './typo.js'
import { addWatermark, watermarkTag, type WmKind } from './watermark.js'

const BUCKET = 'post-media'

// Готовий файл для публікації (фаза 6c). Відповідь Іри 09.10 на п. 8–9: «з текстом, з обробкою, як у тесті; текст всюди — і IG, і TG».
// Усі фото — м'яка обробка (look.py soft: лише яскравість, кольори як в оригіналі) + біла рамка (round6: ~30px на 1080).
// Перше фото — вуаль від краю + текст, який придумує агент (n8n «Photo text»: заголовок + готель/місце, зона без людей).
// Фото 2–10 каруселі — короткий підпис до кожного фото (той самий шрифт, дрібніше).
// Instagram / Threads — обріз 4:5 1080×1350 з розумним кадруванням; Telegram — пропорції оригіналу, довга сторона 1600.
const FRAME = 30 / 1080
const FEED = { w: 1080, h: 1350 }
const TG_LONG = 1600
// Сторіз 9:16 (той самий стиль). Згори й знизу Instagram кладе аватар і поле відповіді — текст відсуваємо на ~9% висоти
const STORY = { w: 1080, h: 1920 }
const STORY_SAFE = 0.09
// Версія оформлення в назві файлу: змінили вигляд (r2 — підписи на кожному фото каруселі; r3 — вуаль під текстом за яскравістю; r4 — без розриву «2–4» і висячих «у», «на»; r5 — Cormorant замість Prata) → старі готові фото не беремо з кешу
const REV = 'r6'

// Ручні правки Іри до конкретного фото (чипи під фото) — render_params.photo_edits[media_id]
export type PhotoEdit = { text?: 'off' | 'top' | 'bottom'; look?: 'none'; crop?: 'centre' | 'north' | 'south'; title?: string; kicker?: string; veil?: 'more' | 'less'; bright?: 'up' | 'down'; size?: 'bigger' | 'smaller'; width?: 'wide' | 'narrow' }
// Знак на фото поста — вибір Іри на весь пост (render_params.wm). Дефолт — горизонтальний wm1:
// рукописний wm3 Іра 19.10 назвала громіздким. 'off' — без знака
export type PostWm = 'wm1' | 'wm3' | 'off'
export const POST_WM: PostWm[] = ['wm1', 'wm3', 'off']
const postWm = (v: unknown): WmKind | null => (v === 'off' ? null : v === 'wm3' ? 'wm3' : 'wm1')
const CROP = { centre: sharp.gravity.centre, north: sharp.gravity.north, south: sharp.gravity.south } as const

// Кадр без тексту: розмір під платформу, біла рамка, кроп. Окремо від тексту — редактор Іри (сет 5) малює прев'ю
// на тому самому кадрі десятки разів, тож кадр кешується (див. baseFor)
export type Base = { w: number; h: number; pad: number; inset: number; iw: number; ih: number; crop: Buffer }
export async function base(src: Buffer, platform: string, edit: PhotoEdit = {}): Promise<Base> {
  // Спершу поворот за EXIF — далі розміри вже «як бачить людина»
  const { data, info } = await sharp(src).rotate().toBuffer({ resolveWithObject: true })
  let w = FEED.w
  let h = FEED.h
  if (platform === 'telegram') {
    const scale = Math.min(1, TG_LONG / Math.max(info.width, info.height))
    w = Math.round(info.width * scale)
    h = Math.round(info.height * scale)
  }
  if (platform === 'story') { w = STORY.w; h = STORY.h }
  const inset = platform === 'story' ? Math.round(h * STORY_SAFE) : 0
  const pad = Math.round((platform === 'telegram' ? Math.max(w, h) : w) * FRAME)
  const iw = w - 2 * pad
  const ih = h - 2 * pad
  const position = edit.crop ? CROP[edit.crop] : sharp.strategy.attention
  const crop = await sharp(data).resize(iw, ih, { fit: 'cover', position }).removeAlpha().toColourspace('srgb').raw().toBuffer()
  return { w, h, pad, inset, iw, ih, crop }
}

// spec — текст Іри з редактора (photo_spec): замість тексту агента, будь-де на фото, вуаль іде за блоком
export async function frame(src: Buffer, platform: string, text?: PhotoText | null, hint?: string | null, edit: PhotoEdit = {}, wm: WmKind | null = null, spec?: PhotoSpec | null): Promise<Buffer> {
  return compose(await base(src, platform, edit), text, hint, edit, wm, spec)
}

export async function compose(b: Base, text: PhotoText | null | undefined, hint: string | null | undefined, edit: PhotoEdit, wm: WmKind | null, spec?: PhotoSpec | null): Promise<Buffer> {
  const { w, h, pad, inset, iw, ih, crop } = b
  if (edit.text === 'off') { text = null; spec = null }
  if (edit.text === 'top' || edit.text === 'bottom') hint = edit.text
  let zone: Zone | null
  let toned: Buffer
  let layer: Buffer | null
  if (spec) {
    layer = await specLayer(w, h, spec, pad, inset)
    zone = layer ? { zone: spec.y < 0.5 ? 'top' : 'bottom', text: spec.color, source: 'hint' } : null
    toned = softVeil(crop, iw, ih, zone, undefined, undefined, layer ? await textBand(layer, w, h, pad) : null, edit.look !== 'none', { bright: edit.bright, free: { strength: spec.veil } })
  } else {
    zone = text?.title ? await calmZone(await sharp(crop, { raw: { width: iw, height: ih, channels: 3 } }).png().toBuffer(), hint) : null
    // Текст рендеримо першим: його рядки = смуга, яку вуаль має накрити повністю
    layer = zone && text ? await textLayer(w, h, text, zone, pad, inset, { size: edit.size, width: edit.width }) : null
    toned = softVeil(crop, iw, ih, zone, undefined, undefined, layer ? await textBand(layer, w, h, pad) : null, edit.look !== 'none', { veil: edit.veil, bright: edit.bright })
  }
  let img = sharp(toned, { raw: { width: iw, height: ih, channels: 3 } }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
  if (layer) img = sharp(await img.png().toBuffer()).composite([{ input: layer }])
  if (wm) img = sharp(await addWatermark(await img.png().toBuffer(), wm, zone?.zone ?? null, pad, inset))
  return img.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
}

// Перший і останній рядок з непрозорими пікселями шару тексту → у координатах фото без рамки
async function textBand(layer: Buffer, w: number, h: number, pad: number): Promise<Band | null> {
  const r = await rows(layer, w, h)
  return r && { y0: Math.max(0, r.y0 - pad), y1: Math.min(h - 2 * pad - 1, r.y1 - pad) }
}
async function rows(layer: Buffer, w: number, h: number): Promise<Band | null> {
  const a = await sharp(layer).ensureAlpha().extractChannel(3).raw().toBuffer()
  let y0 = -1
  let y1 = -1
  for (let row = 0; row < h; row++) {
    let on = false
    for (let col = 0; col < w; col += 2) if (a[row * w + col] > 40) { on = true; break }
    if (on) { if (y0 < 0) y0 = row; y1 = row }
  }
  return y0 < 0 ? null : { y0, y1 }
}

type Overlay = PhotoText & { zone_hint?: string | null; for_text: string; media_id: string }
type Caption = { title: string; zone_hint: string | null }
type Captions = { for_text: string; media_key: string; items: (Caption | null)[] }

// Виклик n8n «Photo text». null — n8n не налаштований / не відповів (фото все одно підуть: м'яко + рамка)
async function photoHook(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const secret = process.env.N8N_WEBHOOK_SECRET
  const s = await getSettings(['n8n_webhook_base'])
  const base = typeof s.n8n_webhook_base === 'string' ? s.n8n_webhook_base.replace(/\/$/, '') : ''
  if (!base || !secret) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}/travellab-photo-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Secret': secret },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const sign = async (path: string) => {
  const r = await db().storage.from(BUCKET).createSignedUrl(path, 600)
  if (r.error) throw r.error
  return r.data.signedUrl
}

type PostInfo = { text: string; platform: string; hotel: string | null }

// Заголовок на перше фото (обкладинка): {kicker, title, zone}
async function coverText(post: PostInfo, mediaId: string, storagePath: string, forText: string): Promise<Overlay | null> {
  const j = await photoHook({ role: 'cover', ...post, image_url: await sign(storagePath) }, 15000)
  const title = String(j?.title ?? '').trim()
  if (!title) return null
  return { title, kicker: String(j?.kicker ?? '').trim() || undefined, zone_hint: (j?.zone as string | null) ?? null, for_text: forText, media_id: mediaId }
}

// Підписи на фото 2–10 каруселі — одним запитом, щоб агент бачив усю карусель і не повторювався
async function captionTexts(post: PostInfo, slides: { id: string; path: string }[], forText: string, key: string): Promise<Captions | null> {
  const urls = await Promise.all(slides.map((x) => sign(x.path)))
  const j = await photoHook({ role: 'captions', ...post, image_urls: urls }, 25000)
  const list = Array.isArray(j?.captions) ? (j!.captions as { title?: string; zone?: string | null }[]) : null
  if (!list?.length) return null
  const items = slides.map((_, i) => {
    const title = String(list[i]?.title ?? '').trim()
    return title ? { title, zone_hint: list[i]?.zone ?? null } : null
  })
  return { for_text: forText, media_key: key, items }
}

type Rendered = { text: string; platform: string; files: { name: string; buf: Buffer }[]; photo_text: string | null }
type Slide = { id: string; i: number; src: string; path: string; text: (PhotoText & { zone_hint?: string | null }) | null; spec: PhotoSpec | null }
type Prepared = { ids: string[]; text: string; platform: string; versionNo: number; edits: Record<string, PhotoEdit>; wm: WmKind | null; wmStory: WmKind | null; first: string | undefined; slides: Slide[]; cover: (PhotoText & { zone_hint?: string | null }) | null }

// Кеш експорту по слайду: ім'я файлу = хеш (фото + текст на ньому + правки + знак + платформа). Одна правка перемальовує лише свій слайд,
// а не всі 10; правка тексту поста не чіпає фото (текст на фото не залежить від тексту поста)
// Спека Іри (photo_spec) — у хеші лише якщо є: старі слайди без неї зберігають свої імена файлів (кеш не злітає)
const slideHash = (platform: string, tag: string, s: { id: string; text: unknown; spec?: PhotoSpec | null }, edit: PhotoEdit | undefined) =>
  createHash('sha1').update(JSON.stringify(s.spec ? [REV, platform, tag, s.id, s.spec, edit ?? null] : [REV, platform, tag, s.id, s.text, edit ?? null])).digest('hex').slice(0, 16)
const exportPath = (planId: string, hash: string) => `exports/${planId}/${REV}_${hash}.jpg`

// Усе потрібне для рендеру БЕЗ малювання: версія, фото, тексти на фото (кеш за media_id; Іра-текст агент не перебиває)
async function prepare(planId: string): Promise<Prepared> {
  const p = await db().from('content_plan').select('platform, version_no, current_version_id, hotel_id').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data?.current_version_id) throw new Error('у поста немає версії')
  const v = await db().from('post_versions').select('id, text, media_ids, render_params').eq('id', p.data.current_version_id).maybeSingle()
  if (v.error) throw v.error
  const ids = ((v.data?.media_ids as string[] | null) ?? []).slice(0, 10)
  const m = ids.length ? await db().from('media').select('media_id, storage_path').in('media_id', ids) : { data: [], error: null }
  if (m.error) throw m.error
  const pathOf = new Map((m.data ?? []).map((x) => [x.media_id as string, x.storage_path as string | null]))

  const platform = String(p.data.platform)
  const text = String(v.data?.text ?? '')
  const params = (v.data?.render_params as Record<string, unknown>) ?? {}
  const edits = (params.photo_edits as Record<string, PhotoEdit> | undefined) ?? {}
  const specs = (params.photo_spec as Record<string, PhotoSpec> | undefined) ?? {}
  const withPath = ids.filter((id) => pathOf.get(id))
  const first = withPath[0]
  const rest = [...new Set(withPath.slice(1))]
  // Текст на фото прив'язаний до фото (media_id), а не до тексту поста: правка тексту поста заголовок на фото не міняє.
  // Якщо на слайді є текст Іри (або вона його вимкнула) — агента (WF-049) для цього слайда не кличемо
  // Спека Іри з редактора (source 'ira') — теж «свій» текст: агент цей слайд не перегенеровує ніколи
  const own = (id: string) => edits[id]?.title !== undefined || edits[id]?.text === 'off' || Boolean(specs[id])
  let overlay: Overlay | null = null
  let captions: Captions | null = null
  if (first && text.trim()) {
    const h = p.data.hotel_id ? await db().from('hotels').select('name, country').eq('hotel_id', p.data.hotel_id).maybeSingle() : null
    const post: PostInfo = { text, platform, hotel: h?.data ? [h.data.name, h.data.country].filter(Boolean).join(', ') : null }
    const key = rest.join(',')
    const forText = createHash('sha1').update(text).digest('hex').slice(0, 12)
    const cachedCover = params.photo_text as Overlay | undefined
    const cachedCaps = params.photo_captions as Captions | undefined
    const coverOk = Boolean(cachedCover?.title && cachedCover.media_id === first)
    const needCover = !coverOk && !own(first)
    const needCaps = rest.length > 0 && !(cachedCaps?.media_key === key) && !rest.every(own)
    const [cover, caps] = await Promise.all([
      needCover ? coverText(post, first, pathOf.get(first)!, forText).catch(() => null) : coverOk ? cachedCover! : null,
      needCaps ? captionTexts(post, rest.map((id) => ({ id, path: pathOf.get(id)! })), forText, key).catch(() => null) : cachedCaps?.media_key === key ? cachedCaps : null,
    ])
    overlay = cover
    captions = rest.length ? caps : null
    const patch: Record<string, unknown> = {}
    if (needCover && cover) patch.photo_text = cover
    if (needCaps && caps) patch.photo_captions = caps
    if (Object.keys(patch).length) await db().from('post_versions').update({ render_params: { ...params, ...patch } }).eq('id', v.data!.id)
  }
  const tag = await watermarkTag()
  const wm: WmKind | null = !tag ? null : postWm(params.wm)
  const wmStory: WmKind | null = !tag ? null : 'wm2'
  // Текст Іри на фото має пріоритет над текстом агента
  const textFor = (id: string): (PhotoText & { zone_hint?: string | null }) | null => {
    const e = edits[id] ?? {}
    if (id === first) {
      const title = e.title ?? overlay?.title
      return title ? { title, kicker: e.kicker !== undefined ? e.kicker || undefined : overlay?.kicker, zone_hint: overlay?.zone_hint ?? null } : null
    }
    const c = captions?.items[rest.indexOf(id)]
    const title = e.title ?? c?.title
    return title ? { title, small: true, zone_hint: c?.zone_hint ?? null } : null
  }
  const slides: Slide[] = []
  ids.forEach((id, i) => {
    const src = pathOf.get(id)
    if (!src) return
    const t = textFor(id)
    const spec = specs[id] ?? null
    slides.push({ id, i, src, text: t, spec, path: exportPath(planId, slideHash(platform, `${tag}|${wm ?? ''}`, { id, text: t, spec }, edits[id])) })
  })
  const fs = first ? specs[first] : undefined
  const cover = !first || edits[first]?.text === 'off' ? null
    : fs ? (() => { const t = fs.blocks.find((b) => b.role === 'title')?.text.trim(); return t ? { title: t, kicker: fs.blocks.find((b) => b.role === 'kicker')?.text.trim() || undefined } : null })()
      : textFor(first)
  return { ids, text, platform, versionNo: Number(p.data.version_no), edits, wm, wmStory, first, slides, cover }
}

// Рендерить фото поточної версії поста; готовий слайд лежить у Storage `exports/<plan>/<REV>_<хеш>.jpg` — незмінений слайд береться з кешу
// story — номер фото: лише воно, у форматі сторіз 9:16, без копії в Storage
export async function render(planId: string, story?: number, pre?: Prepared): Promise<Rendered> {
  const pr = pre ?? (await prepare(planId))
  const files = await Promise.all(
    pr.slides.map(async (s) => {
      if (story !== undefined) {
        if (s.i !== story) return null
        const dl = await db().storage.from(BUCKET).download(s.src)
        if (dl.error) throw dl.error
        const out = await frame(Buffer.from(await dl.data.arrayBuffer()), 'story', s.text, s.text?.zone_hint, pr.edits[s.id], pr.wmStory, s.spec)
        return { name: `travellab_story_${s.i + 1}.jpg`, buf: out }
      }
      const name = `travellab_${pr.platform}_${s.i + 1}.jpg`
      const hit = await db().storage.from(BUCKET).download(s.path)
      if (!hit.error) return { name, buf: Buffer.from(await hit.data.arrayBuffer()) }
      const dl = await db().storage.from(BUCKET).download(s.src)
      if (dl.error) throw dl.error
      const out = await frame(Buffer.from(await dl.data.arrayBuffer()), pr.platform, s.text, s.text?.zone_hint, pr.edits[s.id], pr.wm, s.spec)
      const up = await db().storage.from(BUCKET).upload(s.path, out, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw up.error
      return { name, buf: out }
    }),
  )
  const photo_text = pr.cover ? [pr.cover.kicker, pr.cover.title].filter(Boolean).join(' · ').replace(/\s*\n\s*/g, ' ') : null
  return { text: pr.text, platform: pr.platform, files: files.filter((f) => f !== null), photo_text }
}

// Готовий вигляд поточної версії для апки: Іра одразу бачить фото так, як воно піде (рамка + обробка + текст).
// Перемальовуються лише слайди, чий хеш змінився
export async function previewUrls(planId: string): Promise<{ version_no: number; urls: (string | null)[] }> {
  const pr = await prepare(planId)
  const byId = pr.slides
  const order = pr.ids
  if (!byId.length) return { version_no: pr.versionNo, urls: order.map(() => null) }
  const want = byId.map((s) => s.path)
  let signed = await db().storage.from(BUCKET).createSignedUrls(want, 60 * 60)
  if (signed.error) throw signed.error
  if (signed.data.some((x) => !x.signedUrl)) {
    await render(planId, undefined, pr)
    signed = await db().storage.from(BUCKET).createSignedUrls(want, 60 * 60)
    if (signed.error) throw signed.error
  }
  const bySlide = new Map(byId.map((s, k) => [s.i, signed.data[k]?.signedUrl ?? null]))
  return { version_no: pr.versionNo, urls: order.map((_, i) => bySlide.get(i) ?? null) }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// **жирний** з тексту агента → HTML Telegram (у чаті Іра скопіює вже з форматуванням)
export const toHtml = (text: string) => esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

async function tg(method: string, body: FormData | object) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const isForm = body instanceof FormData
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
  })
  const j = (await r.json()) as { ok: boolean; description?: string }
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`)
}

// Надсилає в чат бота текст поста + фото файлами (без стиснення Telegram) — звідти Іра зберігає в галерею / копіює текст
export async function sendToChat(planId: string, chatId: number) {
  const r = await render(planId)
  const files = r.files
  if (r.text.trim()) await tg('sendMessage', { chat_id: chatId, text: toHtml(r.text).slice(0, 4096), parse_mode: 'HTML' })
  if (files.length === 1) {
    const f = new FormData()
    f.append('chat_id', String(chatId))
    f.append('document', new Blob([new Uint8Array(files[0].buf)], { type: 'image/jpeg' }), files[0].name)
    await tg('sendDocument', f)
  } else if (files.length > 1) {
    const f = new FormData()
    f.append('chat_id', String(chatId))
    f.append('media', JSON.stringify(files.map((x, i) => ({ type: 'document', media: `attach://f${i}` }))))
    files.forEach((x, i) => f.append(`f${i}`, new Blob([new Uint8Array(x.buf)], { type: 'image/jpeg' }), x.name))
    await tg('sendMediaGroup', f)
  }
  return { photos: files.length, photo_text: r.photo_text }
}

// Сторіз 9:16 з фото №slide у чат бота — файлом, як і пост (без стиснення Telegram)
export async function sendStory(planId: string, chatId: number, slide: number) {
  const r = await render(planId, slide)
  const file = r.files[0]
  if (!file) return { photos: 0 }
  const f = new FormData()
  f.append('chat_id', String(chatId))
  f.append('document', new Blob([new Uint8Array(file.buf)], { type: 'image/jpeg' }), file.name)
  await tg('sendDocument', f)
  return { photos: 1 }
}

// ───────────── Редактор тексту на фото (сет 5) ─────────────

export type { PhotoSpec } from './overlay.js'
const SPEC_TEXT_MAX = 140
const PREVIEW_W = 540

// Спека з апки → чиста (межі, типи) або null. source ставить сервер: зберегла Іра → 'ira'
export function cleanSpec(raw: unknown): PhotoSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10000) / 10000)) : null
  }
  const x = num(r.x, 0, 1), y = num(r.y, 0, 1), w = num(r.w, 0.3, 1)
  if (x === null || y === null || w === null || !Array.isArray(r.blocks)) return null
  const veil = r.veil === null || r.veil === undefined ? null : num(r.veil, 0, 0.85)
  const blocks: SpecBlock[] = []
  for (const b of r.blocks.slice(0, 3) as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') return null
    const role = b.role === 'kicker' ? 'kicker' : b.role === 'title' ? 'title' : null
    const font = typeof b.font === 'string' && b.font in FONT ? (b.font as SpecBlock['font']) : null
    const size = num(b.size, 0.012, 0.2), lh = num(b.lh, 0.8, 2)
    if (!role || !font || size === null || lh === null || typeof b.text !== 'string') return null
    const text = b.text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, SPEC_TEXT_MAX)
    const n = wordCount(text)
    const gold = [...new Set((Array.isArray(b.gold) ? b.gold : []).map(Number).filter((g) => Number.isInteger(g) && g >= 0 && g < n))].sort((p, q) => p - q).slice(0, 6)
    blocks.push({ role, text, font, size, lh, gold, cap: b.cap === 'upper' ? 'upper' : null })
  }
  return { v: 1, x, y, w, veil, color: r.color === 'dark' ? 'dark' : 'light', blocks, source: 'ira' }
}

// Теплий інстанс Vercel: Іра тягає текст — прев'ю щоразу на тому самому кадрі. Тримаємо кілька останніх кадрів (≈4 МБ кожен)
const baseCache = new Map<string, Promise<Base>>()
function baseFor(path: string, platform: string, edit: PhotoEdit): Promise<Base> {
  const key = [path, platform, edit.crop ?? '', edit.look ?? ''].join('|')
  let hit = baseCache.get(key)
  if (!hit) {
    hit = (async () => {
      const dl = await db().storage.from(BUCKET).download(path)
      if (dl.error) throw dl.error
      return base(Buffer.from(await dl.data.arrayBuffer()), platform, edit)
    })()
    hit.catch(() => baseCache.delete(key))
    baseCache.set(key, hit)
    while (baseCache.size > 4) baseCache.delete(baseCache.keys().next().value!)
  }
  return hit
}

// Легкий контекст одного фото поста (без агента): платформа, шлях, правки, знак, спека
async function slideCtx(planId: string, mediaId: string) {
  const p = await db().from('content_plan').select('platform, current_version_id').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data?.current_version_id) return null
  const v = await db().from('post_versions').select('media_ids, render_params').eq('id', p.data.current_version_id).maybeSingle()
  if (v.error) throw v.error
  if (!((v.data?.media_ids as string[] | null) ?? []).includes(mediaId)) return null
  const [m, tag] = await Promise.all([db().from('media').select('storage_path').eq('media_id', mediaId).maybeSingle(), watermarkTag()])
  if (m.error) throw m.error
  const path = m.data?.storage_path as string | null
  if (!path) return null
  const params = (v.data?.render_params as Record<string, unknown>) ?? {}
  const edit = ((params.photo_edits as Record<string, PhotoEdit> | undefined) ?? {})[mediaId] ?? {}
  return { platform: String(p.data.platform), path, edit, wm: tag ? postWm(params.wm) : null, spec: ((params.photo_spec as Record<string, PhotoSpec> | undefined) ?? {})[mediaId] ?? null }
}

const small = async (jpg: Buffer) => `data:image/jpeg;base64,${(await sharp(jpg).resize(PREVIEW_W).jpeg({ quality: 82 }).toBuffer()).toString('base64')}`

// Те, що зараз на фото, як спека: збережена Ірою — як є; інакше з тексту агента / старих правок (той самий вигляд, що файл зараз)
async function deriveSpec(planId: string, mediaId: string, b: Base, edit: PhotoEdit): Promise<PhotoSpec> {
  const pr = await prepare(planId)
  const s = pr.slides.find((x) => x.id === mediaId)
  if (s?.spec) return s.spec
  return specFromAgent(b, edit.text === 'off' ? null : s?.text ?? null, edit, mediaId === pr.first)
}

// Текст агента (+ старі правки фото) → спека з тим самим виглядом
export async function specFromAgent(b: Base, t: (PhotoText & { zone_hint?: string | null }) | null, edit: PhotoEdit, first: boolean): Promise<PhotoSpec> {
  const zone = await calmZone(await sharp(b.crop, { raw: { width: b.iw, height: b.ih, channels: 3 } }).png().toBuffer(), edit.text === 'top' || edit.text === 'bottom' ? edit.text : t?.zone_hint)
  const mul = edit.size === 'bigger' ? 1.2 : edit.size === 'smaller' ? 0.85 : 1
  const title = t?.title ?? ''
  const blocks: SpecBlock[] = [
    ...(first || t?.kicker ? [{ role: 'kicker' as const, text: t?.kicker ?? '', font: 'tenor' as const, size: 0.026, lh: 1.3, gold: [], cap: 'upper' as const }] : []),
    { role: 'title', text: title, font: 'cormorant', size: Math.round((t?.small ? 0.05 : title.length > 34 ? 0.058 : 0.068) * 1.1 * mul * 10000) / 10000, lh: 1.18, gold: [], cap: null },
  ]
  const side = edit.width === 'wide' ? 0.035 : edit.width === 'narrow' ? 0.18 : 0.09
  const spec: PhotoSpec = { v: 1, x: 0.5, y: zone.zone === 'top' ? 0.18 : 0.82, w: Math.round((1 - 2 * side) * 1000) / 1000, veil: null, color: zone.text, blocks, source: 'ai' }
  if (!t?.title) return spec
  // Центр блоку = центр тексту агента на файлі зараз: міряємо обидва шари й зсуваємо спеку на різницю
  const [old, mine] = await Promise.all([textLayer(b.w, b.h, t, zone, b.pad, b.inset, { size: edit.size, width: edit.width }), specLayer(b.w, b.h, spec, b.pad, b.inset)])
  const [ro, rm] = await Promise.all([rows(old, b.w, b.h), mine ? rows(mine, b.w, b.h) : null])
  if (ro && rm) spec.y = Math.min(0.97, Math.max(0.03, Math.round((spec.y + ((ro.y0 + ro.y1) - (rm.y0 + rm.y1)) / 2 / (b.ih - 2 * b.inset)) * 10000) / 10000))
  return spec
}

// Прев'ю для редактора (нічого не зберігає): той самий рендер, що файл у чаті, зменшений до 540 px.
// Без spec — поточна спека фото (+ чистий кадр bg для миттєвого DOM-прев'ю і розміри кадру)
export async function photoPreview(planId: string, mediaId: string, raw: unknown, withBg: boolean) {
  const c = await slideCtx(planId, mediaId)
  if (!c) return null
  const b = await baseFor(c.path, c.platform, c.edit)
  const spec = raw === undefined || raw === null ? await deriveSpec(planId, mediaId, b, c.edit) : cleanSpec(raw)
  if (!spec) return null
  const [jpg, bg] = await Promise.all([
    compose(b, null, null, { ...c.edit, text: undefined }, c.wm, spec).then(small),
    withBg ? compose(b, null, null, { ...c.edit, text: 'off' }, null, null).then(small) : null,
  ])
  return { jpg, ...(bg ? { bg } : {}), spec, frame: { w: b.w, h: b.h, pad: b.pad, inset: b.inset }, saved: c.spec !== null }
}

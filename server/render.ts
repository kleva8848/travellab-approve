import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { db, getSettings } from './http.js'
import { calmZone, softVeil, type Zone } from './look.js'
import { textLayer, type PhotoText } from './overlay.js'

const BUCKET = 'post-media'

// Готовий файл для публікації (фаза 6c). Відповідь Іри 09.10 на п. 8–9: «з текстом, з обробкою, як у тесті; текст всюди — і IG, і TG».
// Усі фото — м'яка обробка (look.py soft: лише яскравість, кольори як в оригіналі) + біла рамка (round6: ~30px на 1080).
// Перше фото — вуаль від краю + текст, який придумує агент (n8n «Photo text»: заголовок + готель/місце, зона без людей).
// Instagram / Threads — обріз 4:5 1080×1350 з розумним кадруванням; Telegram — пропорції оригіналу, довга сторона 1600.
const FRAME = 30 / 1080
const FEED = { w: 1080, h: 1350 }
const TG_LONG = 1600

export async function frame(src: Buffer, platform: string, text?: PhotoText | null, hint?: string | null): Promise<Buffer> {
  // Спершу поворот за EXIF — далі розміри вже «як бачить людина»
  const { data, info } = await sharp(src).rotate().toBuffer({ resolveWithObject: true })
  let w = FEED.w
  let h = FEED.h
  if (platform === 'telegram') {
    const scale = Math.min(1, TG_LONG / Math.max(info.width, info.height))
    w = Math.round(info.width * scale)
    h = Math.round(info.height * scale)
  }
  const pad = Math.round((platform === 'telegram' ? Math.max(w, h) : w) * FRAME)
  const iw = w - 2 * pad
  const ih = h - 2 * pad
  const crop = await sharp(data).resize(iw, ih, { fit: 'cover', position: sharp.strategy.attention }).removeAlpha().toColourspace('srgb').raw().toBuffer()
  const zone: Zone | null = text?.title ? await calmZone(await sharp(crop, { raw: { width: iw, height: ih, channels: 3 } }).png().toBuffer(), hint) : null
  const toned = softVeil(crop, iw, ih, zone)
  let img = sharp(toned, { raw: { width: iw, height: ih, channels: 3 } }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
  if (zone && text) img = sharp(await img.png().toBuffer()).composite([{ input: await textLayer(w, h, text, zone, pad) }])
  return img.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
}

type Overlay = PhotoText & { zone_hint?: string | null; for_text: string; media_id: string }

// Текст на фото від агента (n8n). Кеш у post_versions.render_params.photo_text — поки текст поста й перше фото ті самі
async function photoText(versionId: string, params: Record<string, unknown>, post: { text: string; platform: string; hotel: string | null }, mediaId: string, storagePath: string): Promise<Overlay | null> {
  const forText = createHash('sha1').update(post.text).digest('hex').slice(0, 12)
  const cached = params.photo_text as Overlay | undefined
  if (cached?.title && cached.for_text === forText && cached.media_id === mediaId) return cached

  const secret = process.env.N8N_WEBHOOK_SECRET
  const s = await getSettings(['n8n_webhook_base'])
  const base = typeof s.n8n_webhook_base === 'string' ? s.n8n_webhook_base.replace(/\/$/, '') : ''
  if (!base || !secret) return null
  const signed = await db().storage.from(BUCKET).createSignedUrl(storagePath, 600)
  if (signed.error) throw signed.error
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const r = await fetch(`${base}/travellab-photo-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Secret': secret },
      body: JSON.stringify({ text: post.text, platform: post.platform, hotel: post.hotel, image_url: signed.data.signedUrl }),
      signal: ctrl.signal,
    })
    if (!r.ok) return null
    const j = (await r.json()) as { title?: string; kicker?: string; zone?: string }
    const title = String(j.title ?? '').trim()
    if (!title) return null
    const o: Overlay = { title, kicker: String(j.kicker ?? '').trim() || undefined, zone_hint: j.zone ?? null, for_text: forText, media_id: mediaId }
    await db().from('post_versions').update({ render_params: { ...params, photo_text: o } }).eq('id', versionId)
    return o
  } catch {
    return null // без тексту фото все одно піде (м'яко + рамка) — пост не блокуємо
  } finally {
    clearTimeout(timer)
  }
}

type Rendered = { text: string; platform: string; files: { name: string; buf: Buffer }[]; photo_text: string | null }

// Рендерить фото поточної версії поста; копія лягає в Storage `exports/<plan>/v<N>_<i>.jpg` (повторний виклик перезаписує) — для календаря/історії
async function render(planId: string): Promise<Rendered> {
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
  let overlay: Overlay | null = null
  const first = ids.find((id) => pathOf.get(id))
  if (first && text.trim()) {
    const h = p.data.hotel_id ? await db().from('hotels').select('name, country').eq('hotel_id', p.data.hotel_id).maybeSingle() : null
    const hotel = h?.data ? [h.data.name, h.data.country].filter(Boolean).join(', ') : null
    overlay = await photoText(v.data!.id as string, (v.data?.render_params as Record<string, unknown>) ?? {}, { text, platform, hotel }, first, pathOf.get(first)!)
  }

  const files = await Promise.all(
    ids.map(async (id, i) => {
      const src = pathOf.get(id)
      if (!src) return null
      const dl = await db().storage.from(BUCKET).download(src)
      if (dl.error) throw dl.error
      const withText = id === first ? overlay : null
      const out = await frame(Buffer.from(await dl.data.arrayBuffer()), platform, withText, withText?.zone_hint)
      const path = `exports/${planId}/v${p.data!.version_no}_${i + 1}.jpg`
      const up = await db().storage.from(BUCKET).upload(path, out, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw up.error
      return { name: `travellab_${platform}_${i + 1}.jpg`, buf: out }
    }),
  )
  const photo_text = overlay ? [overlay.kicker, overlay.title].filter(Boolean).join(' · ') : null
  return { text, platform, files: files.filter((f) => f !== null), photo_text }
}

// Готовий вигляд поточної версії для апки: Іра одразу бачить фото так, як воно піде (рамка + обробка + текст).
// Рендер кешується в exports/<plan>/v<N>_<i>.jpg — нова версія (інше фото / текст) = новий номер → новий рендер
export async function previewUrls(planId: string): Promise<{ version_no: number; urls: (string | null)[] }> {
  const p = await db().from('content_plan').select('version_no, current_version_id').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data?.current_version_id) return { version_no: 0, urls: [] }
  const n = Number(p.data.version_no)
  const v = await db().from('post_versions').select('media_ids').eq('id', p.data.current_version_id).maybeSingle()
  if (v.error) throw v.error
  const ids = ((v.data?.media_ids as string[] | null) ?? []).slice(0, 10)
  if (!ids.length) return { version_no: n, urls: [] }
  const m = await db().from('media').select('media_id, storage_path').in('media_id', ids)
  if (m.error) throw m.error
  const has = new Set((m.data ?? []).filter((x) => x.storage_path).map((x) => x.media_id as string))
  const paths = ids.map((id, i) => (has.has(id) ? `exports/${planId}/v${n}_${i + 1}.jpg` : null))
  const want = paths.filter((x): x is string => Boolean(x))
  if (!want.length) return { version_no: n, urls: paths }

  const list = await db().storage.from(BUCKET).list(`exports/${planId}`, { search: `v${n}_`, limit: 100 })
  const ready = new Set((list.data ?? []).map((f) => `exports/${planId}/${f.name}`))
  if (!want.every((x) => ready.has(x))) await render(planId)

  const signed = await db().storage.from(BUCKET).createSignedUrls(want, 60 * 60)
  if (signed.error) throw signed.error
  const byPath = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]))
  return { version_no: n, urls: paths.map((x) => (x ? byPath.get(x) ?? null : null)) }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// **жирний** з тексту агента → HTML Telegram (у чаті Іра скопіює вже з форматуванням)
const toHtml = (text: string) => esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

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

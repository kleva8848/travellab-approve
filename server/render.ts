import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { db, getSettings } from './http.js'
import { calmZone, softVeil, type Zone } from './look.js'
import { textLayer, type PhotoText } from './overlay.js'

const BUCKET = 'post-media'

// Готовий файл для публікації (фаза 6c). Відповідь Іри 09.10 на п. 8–9: «з текстом, з обробкою, як у тесті; текст всюди — і IG, і TG».
// Усі фото — м'яка обробка (look.py soft: лише яскравість, кольори як в оригіналі) + біла рамка (round6: ~30px на 1080).
// Перше фото — вуаль від краю + текст, який придумує агент (n8n «Photo text»: заголовок + готель/місце, зона без людей).
// Фото 2–10 каруселі — короткий підпис до кожного фото (той самий шрифт, дрібніше).
// Instagram / Threads — обріз 4:5 1080×1350 з розумним кадруванням; Telegram — пропорції оригіналу, довга сторона 1600.
const FRAME = 30 / 1080
const FEED = { w: 1080, h: 1350 }
const TG_LONG = 1600
// Версія оформлення в назві файлу: змінили вигляд (r2 — підписи на кожному фото каруселі) → старі готові фото не беремо з кешу
const REV = 'r2'
const exportPath = (planId: string, versionNo: number, i: number) => `exports/${planId}/v${versionNo}${REV}_${i + 1}.jpg`

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
  const j = await photoHook({ role: 'cover', ...post, image_url: await sign(storagePath) }, 30000)
  const title = String(j?.title ?? '').trim()
  if (!title) return null
  return { title, kicker: String(j?.kicker ?? '').trim() || undefined, zone_hint: (j?.zone as string | null) ?? null, for_text: forText, media_id: mediaId }
}

// Підписи на фото 2–10 каруселі — одним запитом, щоб агент бачив усю карусель і не повторювався
async function captionTexts(post: PostInfo, slides: { id: string; path: string }[], forText: string, key: string): Promise<Captions | null> {
  const urls = await Promise.all(slides.map((x) => sign(x.path)))
  const j = await photoHook({ role: 'captions', ...post, image_urls: urls }, 50000)
  const list = Array.isArray(j?.captions) ? (j!.captions as { title?: string; zone?: string | null }[]) : null
  if (!list?.length) return null
  const items = slides.map((_, i) => {
    const title = String(list[i]?.title ?? '').trim()
    return title ? { title, zone_hint: list[i]?.zone ?? null } : null
  })
  return { for_text: forText, media_key: key, items }
}

type Rendered = { text: string; platform: string; files: { name: string; buf: Buffer }[]; photo_text: string | null }

// Рендерить фото поточної версії поста; копія лягає в Storage `exports/<plan>/v<N><REV>_<i>.jpg` (повторний виклик перезаписує) — для календаря/історії
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
  const params = (v.data?.render_params as Record<string, unknown>) ?? {}
  const withPath = ids.filter((id) => pathOf.get(id))
  const first = withPath[0]
  const rest = [...new Set(withPath.slice(1))]
  // Кеш текстів на фото — у post_versions.render_params, поки текст поста і фото ті самі
  const forText = createHash('sha1').update(text).digest('hex').slice(0, 12)
  let overlay: Overlay | null = null
  let captions: Captions | null = null
  if (first && text.trim()) {
    const h = p.data.hotel_id ? await db().from('hotels').select('name, country').eq('hotel_id', p.data.hotel_id).maybeSingle() : null
    const post: PostInfo = { text, platform, hotel: h?.data ? [h.data.name, h.data.country].filter(Boolean).join(', ') : null }
    const key = rest.join(',')
    const cachedCover = params.photo_text as Overlay | undefined
    const cachedCaps = params.photo_captions as Captions | undefined
    const coverOk = Boolean(cachedCover?.title && cachedCover.for_text === forText && cachedCover.media_id === first)
    const capsOk = !rest.length || (cachedCaps?.for_text === forText && cachedCaps.media_key === key)
    const [cover, caps] = await Promise.all([
      coverOk ? cachedCover! : coverText(post, first, pathOf.get(first)!, forText).catch(() => null),
      capsOk ? cachedCaps ?? null : captionTexts(post, rest.map((id) => ({ id, path: pathOf.get(id)! })), forText, key).catch(() => null),
    ])
    overlay = cover
    captions = rest.length ? caps : null
    const patch: Record<string, unknown> = {}
    if (!coverOk && cover) patch.photo_text = cover
    if (!capsOk && caps) patch.photo_captions = caps
    if (Object.keys(patch).length) await db().from('post_versions').update({ render_params: { ...params, ...patch } }).eq('id', v.data!.id)
  }
  const textFor = (id: string): (PhotoText & { zone_hint?: string | null }) | null => {
    if (id === first) return overlay
    const c = captions?.items[rest.indexOf(id)]
    return c ? { title: c.title, small: true, zone_hint: c.zone_hint } : null
  }

  const files = await Promise.all(
    ids.map(async (id, i) => {
      const src = pathOf.get(id)
      if (!src) return null
      const dl = await db().storage.from(BUCKET).download(src)
      if (dl.error) throw dl.error
      const withText = textFor(id)
      const out = await frame(Buffer.from(await dl.data.arrayBuffer()), platform, withText, withText?.zone_hint)
      const path = exportPath(planId, Number(p.data!.version_no), i)
      const up = await db().storage.from(BUCKET).upload(path, out, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw up.error
      return { name: `travellab_${platform}_${i + 1}.jpg`, buf: out }
    }),
  )
  const photo_text = overlay ? [overlay.kicker, overlay.title].filter(Boolean).join(' · ') : null
  return { text, platform, files: files.filter((f) => f !== null), photo_text }
}

// Готовий вигляд поточної версії для апки: Іра одразу бачить фото так, як воно піде (рамка + обробка + текст).
// Рендер кешується в exports/<plan>/v<N><REV>_<i>.jpg — нова версія (інше фото / текст) = новий номер → новий рендер
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
  const paths = ids.map((id, i) => (has.has(id) ? exportPath(planId, n, i) : null))
  const want = paths.filter((x): x is string => Boolean(x))
  if (!want.length) return { version_no: n, urls: paths }

  const list = await db().storage.from(BUCKET).list(`exports/${planId}`, { search: `v${n}${REV}_`, limit: 100 })
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

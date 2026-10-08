import sharp from 'sharp'
import { db } from './http.js'

const BUCKET = 'post-media'

// Готовий файл для публікації (фаза 6c, мінімум): фото БЕЗ обробки кольору + біла рамка (round6: ~30px на 1080).
// Instagram / Threads — обріз 4:5 1080×1350 з розумним кадруванням; Telegram — пропорції оригіналу, довга сторона 1600.
// Режим «м'яко» (look.py soft + вуаль під текст) додамо перемикачем, коли Іра вибере (PDF раунду 7)
const FRAME = 30 / 1080
const FEED = { w: 1080, h: 1350 }
const TG_LONG = 1600

async function frame(src: Buffer, platform: string): Promise<Buffer> {
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
  return sharp(data)
    .resize(w - 2 * pad, h - 2 * pad, { fit: 'cover', position: sharp.strategy.attention })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer()
}

type Rendered = { text: string; platform: string; files: { name: string; buf: Buffer }[] }

// Рендерить фото поточної версії поста; копія лягає в Storage `exports/<plan>/v<N>_<i>.jpg` (повторний виклик перезаписує) — для календаря/історії
async function render(planId: string): Promise<Rendered> {
  const p = await db().from('content_plan').select('platform, version_no, current_version_id').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data?.current_version_id) throw new Error('у поста немає версії')
  const v = await db().from('post_versions').select('text, media_ids').eq('id', p.data.current_version_id).maybeSingle()
  if (v.error) throw v.error
  const ids = ((v.data?.media_ids as string[] | null) ?? []).slice(0, 10)
  const m = ids.length ? await db().from('media').select('media_id, storage_path').in('media_id', ids) : { data: [], error: null }
  if (m.error) throw m.error
  const pathOf = new Map((m.data ?? []).map((x) => [x.media_id as string, x.storage_path as string | null]))

  const platform = String(p.data.platform)
  const files = await Promise.all(
    ids.map(async (id, i) => {
      const src = pathOf.get(id)
      if (!src) return null
      const dl = await db().storage.from(BUCKET).download(src)
      if (dl.error) throw dl.error
      const out = await frame(Buffer.from(await dl.data.arrayBuffer()), platform)
      const path = `exports/${planId}/v${p.data!.version_no}_${i + 1}.jpg`
      const up = await db().storage.from(BUCKET).upload(path, out, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw up.error
      return { name: `travellab_${platform}_${i + 1}.jpg`, buf: out }
    }),
  )
  return { text: String(v.data?.text ?? ''), platform, files: files.filter((f) => f !== null) }
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
  return { photos: files.length }
}

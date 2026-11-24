import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'
import { failSchema } from '../server/schema.js'
import { insertOwnMedia, isUploadPath, uploadExists, uploadUrl } from '../server/media.js'
import { notifyN8n } from '../server/review.js'

type HotelRow = { hotel_id: string; name: string | null; country: string | null; status: string; paused_at: string | null }
type PlanLite = { hotel_id: string; review_status: string; scheduled_for: string | null; published_at: string | null }

const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

// Вкладка «Готелі»: список активних і поставлених на паузу (needs_review не показуємо — їх підтверджує WF-055),
// з фото, останнім постом і кількістю майбутніх слотів.
async function load() {
  const h = await db().from('hotels').select('hotel_id, name, country, status, paused_at').in('status', ['Active', 'Inactive']).order('name')
  if (h.error) throw h.error
  const hotels = (h.data ?? []) as HotelRow[]
  const ids = hotels.map((x) => x.hotel_id)
  if (!ids.length) return { hotels: [] }
  const [p, photos] = await Promise.all([
    db().from('content_plan').select('hotel_id, review_status, scheduled_for, published_at').in('hotel_id', ids).neq('review_status', 'backlog').order('scheduled_for', { ascending: false }).limit(1000),
    Promise.all(ids.map((id) => db().from('media').select('media_id', { count: 'exact', head: true }).eq('hotel_id', id).not('storage_path', 'is', null))),
  ])
  if (p.error) throw p.error
  const today = kyivToday()
  const plans = (p.data ?? []) as PlanLite[]
  return {
    hotels: hotels.map((x, i) => {
      const mine = plans.filter((y) => y.hotel_id === x.hotel_id)
      const last = mine.filter((y) => y.review_status === 'published').map((y) => y.scheduled_for ?? y.published_at?.slice(0, 10) ?? '').sort().pop() || null
      const upcoming = mine.filter((y) => y.scheduled_for && y.scheduled_for >= today && !['published', 'skipped', 'missed', 'failed'].includes(y.review_status)).length
      return { hotel_id: x.hotel_id, name: x.name ?? x.hotel_id, country: x.country, paused: x.status === 'Inactive', paused_at: x.paused_at, photos: photos[i].error ? 0 : photos[i].count ?? 0, last_post: last, upcoming }
    }),
  }
}

// GET → { hotels: [...] }
// POST { action: 'upload_url' | 'add_photos', hotel_id, items? } → фото в бібліотеку готелю
// POST { action: 'pause' | 'resume', hotel_id } → { ok, skipped? | restored?, hotels }
// Пауза: готель → Inactive (WF-018 бере лише Active) + майбутні ненаписані слоти → skipped (SQL 027, tl_pause_hotel)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  try {
    if (req.method === 'GET') return void res.json(await load())
    if (req.method !== 'POST') return void res.status(405).json({ error: 'GET / POST only' })
    const b = (req.body ?? {}) as Record<string, unknown>
    const hotelId = String(b.hotel_id ?? '')
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(hotelId)) return void res.status(400).json({ error: 'bad hotel_id' })
    // Фото в бібліотеку готелю без поста: підписане посилання → файл у Storage → рядки media (агент сам опише через Vision)
    if (b.action === 'upload_url' || b.action === 'add_photos') {
      const h = await db().from('hotels').select('hotel_id').eq('hotel_id', hotelId).maybeSingle()
      if (h.error) throw h.error
      if (!h.data) return void res.status(404).json({ error: 'not_found' })
      const scope = `hotel-${hotelId}`
      if (b.action === 'upload_url') return void res.json({ ok: true, ...(await uploadUrl(scope)) })
      const items = (Array.isArray(b.items) ? (b.items as { path?: string; width?: number; height?: number }[]) : []).slice(0, 10)
      if (!items.length || items.some((i) => !isUploadPath(scope, String(i.path ?? '')))) return void res.status(400).json({ error: 'bad path' })
      if (!(await Promise.all(items.map((i) => uploadExists(String(i.path))))).every(Boolean)) return void res.status(400).json({ error: 'файл не завантажився' })
      const dim = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 && (x as number) < 20000 ? (x as number) : null)
      const ids: string[] = []
      for (const i of items) ids.push(await insertOwnMedia({ hotel_id: hotelId, storage_path: String(i.path), width: dim(i.width), height: dim(i.height) }))
      await Promise.all(ids.map((id) => notifyN8n({ media_id: id }, 'travellab-media-describe')))
      return void res.json({ ok: true, added: ids.length, ...(await load()) })
    }
    if (b.action !== 'pause' && b.action !== 'resume') return void res.status(400).json({ error: 'unknown action' })
    const r = await db().rpc(b.action === 'pause' ? 'tl_pause_hotel' : 'tl_resume_hotel', { p_hotel_id: hotelId })
    if (r.error) throw r.error
    const out = (r.data ?? {}) as { ok?: boolean; error?: string; skipped?: number; restored?: number }
    if (!out.ok) return void res.status(out.error === 'not_found' ? 404 : 409).json({ error: out.error ?? 'conflict' })
    res.json({ ok: true, skipped: out.skipped, restored: out.restored, ...(await load()) })
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

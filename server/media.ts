import { db } from './http.js'

export type MediaView = { media_id: string; url: string | null; description: string | null; width: number | null; height: number | null }

const BUCKET = 'post-media'
const TTL_SEC = 60 * 60

// Фото для показу в апці: signed URL на 1 год (bucket приватний)
export async function mediaViews(ids: string[]): Promise<Record<string, MediaView>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return {}
  const r = await db().from('media').select('media_id, storage_path, description, width, height').in('media_id', unique)
  if (r.error) throw r.error
  const rows = (r.data ?? []) as { media_id: string; storage_path: string | null; description: string | null; width: number | null; height: number | null }[]
  const paths = rows.map((m) => m.storage_path).filter(Boolean) as string[]
  const signed = paths.length ? await db().storage.from(BUCKET).createSignedUrls(paths, TTL_SEC) : { data: [], error: null }
  if (signed.error) throw signed.error
  const byPath = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]))
  return Object.fromEntries(
    rows.map((m) => [m.media_id, { media_id: m.media_id, url: m.storage_path ? byPath.get(m.storage_path) ?? null : null, description: m.description, width: m.width, height: m.height }]),
  )
}

// Скільки фото готелю вже готові до показу (0 → апка пропонує додати своє)
export async function hotelPhotoCount(hotelId: string | null): Promise<number> {
  if (!hotelId) return 0
  const r = await db().from('media').select('media_id', { count: 'exact', head: true }).eq('hotel_id', hotelId).not('storage_path', 'is', null)
  return r.error ? 0 : r.count ?? 0
}

// ───────────── Своє фото (фаза 6b) ─────────────

const UPLOAD_RE = (planId: string) => new RegExp(`^uploads/${planId}/[a-z0-9-]{8,40}\\.jpg$`)

// Підписане посилання: апка вантажить файл прямо в Storage (повз ліміт тіла Vercel ~4.5 МБ)
export async function uploadUrl(planId: string) {
  const path = `uploads/${planId}/${crypto.randomUUID()}.jpg`
  const r = await db().storage.from(BUCKET).createSignedUploadUrl(path)
  if (r.error) throw r.error
  return { path, signed_url: r.data.signedUrl }
}

export function isUploadPath(planId: string, path: string) {
  return UPLOAD_RE(planId).test(path)
}

export async function uploadExists(path: string): Promise<boolean> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const name = path.slice(path.lastIndexOf('/') + 1)
  const r = await db().storage.from(BUCKET).list(dir, { search: name, limit: 1 })
  return !r.error && (r.data ?? []).some((f) => f.name === name)
}

// Новий рядок media з номером MED-NNN — тим самим, що й бот /upload (WF-022 бере «останній» media_id за текстом)
export async function insertOwnMedia(row: { hotel_id: string | null; storage_path: string; width: number | null; height: number | null }): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const last = await db().from('media').select('media_id').like('media_id', 'MED-%').order('media_id', { ascending: false }).limit(1)
    if (last.error) throw last.error
    const n = Number(/(\d+)$/.exec(last.data?.[0]?.media_id ?? '')?.[1] ?? 0) + 1
    const media_id = `MED-${String(n).padStart(3, '0')}`
    const ins = await db().from('media').insert({
      media_id, hotel_id: row.hotel_id, type: 'photo', source: 'ira_personal', quality: 'ira_app',
      storage_path: row.storage_path, synced_at: new Date().toISOString(), width: row.width, height: row.height, usage_count: 0,
    })
    if (!ins.error) return media_id
    if (ins.error.code !== '23505') throw ins.error // інакше хтось щойно зайняв цей номер — пробуємо наступний
  }
  throw new Error('не вдалося видати номер фото')
}

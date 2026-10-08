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

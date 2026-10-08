import { db, getSettings } from './http.js'
import { hotelPhotoCount, mediaViews } from './media.js'

// Статуси, які показуємо Ірі в черзі «на перегляд» (backlog — старі чернетки Notion-епохи, не показуємо)
export const QUEUE_STATUSES = ['ready_for_review', 'changes_requested', 'regenerating', 'needs_data'] as const
export const ACTIVE_STATUSES = [...QUEUE_STATUSES, 'approved'] as const

export type PlanRow = {
  id: string
  day: string
  platform: string
  slot_type: string
  pillar: string
  tour_id: string | null
  hotel_id: string | null
  scheduled_for: string | null
  slot_time: string | null
  review_status: string
  version_no: number
  current_version_id: string | null
  approved_at: string | null
  published_at: string | null
}

export type VersionRow = {
  id: string
  version_no: number
  text_v: number
  image_v: number
  text: string | null
  hooks: string[] | null
  form: string | null
  key_idea: string | null
  media_ids: string[]
  rendered_urls: string[]
  trigger: string
  comment_id: string | null
  model: string | null
  prompt_version: string | null
  lint: unknown
  missing_facts: unknown
  created_at: string
}

export type CommentRow = {
  id: string
  version_id: string | null
  target: 'text' | 'photo'
  body: string
  chips: string[]
  source: string
  status: string
  created_at: string
}

const PLAN_COLS =
  'id, day, platform, slot_type, pillar, tour_id, hotel_id, scheduled_for, slot_time, review_status, version_no, current_version_id, approved_at, published_at'

// Порядок у черзі: спершу з датою (найближчі), далі за днем тижня в плані
const DAY_ORDER: Record<string, number> = { 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6, 'Нд': 7 }
export function sortPlan<T extends Pick<PlanRow, 'scheduled_for' | 'day' | 'platform'>>(rows: T[]): T[] {
  const plat: Record<string, number> = { telegram: 1, instagram: 2, threads: 3 }
  return [...rows].sort(
    (a, b) =>
      (a.scheduled_for ?? '9999').localeCompare(b.scheduled_for ?? '9999') ||
      (DAY_ORDER[a.day] ?? 9) - (DAY_ORDER[b.day] ?? 9) ||
      (plat[a.platform] ?? 9) - (plat[b.platform] ?? 9),
  )
}

async function namesFor(rows: Pick<PlanRow, 'hotel_id' | 'tour_id'>[]) {
  const hotelIds = [...new Set(rows.map((r) => r.hotel_id).filter(Boolean))] as string[]
  const tourIds = [...new Set(rows.map((r) => r.tour_id).filter(Boolean))] as string[]
  const [h, t] = await Promise.all([
    hotelIds.length ? db().from('hotels').select('hotel_id, name, country').in('hotel_id', hotelIds) : Promise.resolve({ data: [], error: null }),
    tourIds.length ? db().from('tours').select('tour_id, title, destination, price_range, dates_example').in('tour_id', tourIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (h.error) throw h.error
  if (t.error) throw t.error
  return {
    hotels: new Map((h.data ?? []).map((x) => [x.hotel_id as string, x])),
    tours: new Map((t.data ?? []).map((x) => [x.tour_id as string, x])),
  }
}

export async function loadQueue() {
  const r = await db().from('content_plan').select(PLAN_COLS).in('review_status', [...ACTIVE_STATUSES])
  if (r.error) throw r.error
  const rows = sortPlan((r.data ?? []) as PlanRow[])
  const versionIds = rows.map((x) => x.current_version_id).filter(Boolean) as string[]
  const v = versionIds.length
    ? await db().from('post_versions').select('id, text, form, key_idea').in('id', versionIds)
    : { data: [], error: null }
  if (v.error) throw v.error
  const versions = new Map((v.data ?? []).map((x) => [x.id as string, x]))
  const { hotels, tours } = await namesFor(rows)
  return rows.map((p) => {
    const ver = p.current_version_id ? versions.get(p.current_version_id) : undefined
    return {
      ...p,
      hotel_name: (p.hotel_id && hotels.get(p.hotel_id)?.name) || null,
      tour_title: (p.tour_id && tours.get(p.tour_id)?.title) || null,
      preview: (ver?.text ?? '').replace(/\*\*/g, '').slice(0, 140),
    }
  })
}

const PHOTO_STATUSES = new Set(['ready_for_review', 'changes_requested', 'needs_data'])

// Пост без фото → один раз підставляємо фото готелю з наявних (SQL tl_attach_photos, фаза 6a).
// До міграції 004 функції ще нема — тоді просто показуємо пост без фото.
async function autoAttachPhotos(plan: PlanRow): Promise<boolean> {
  if (!plan.hotel_id || !plan.current_version_id || !PHOTO_STATUSES.has(plan.review_status)) return false
  const v = await db().from('post_versions').select('media_ids').eq('id', plan.current_version_id).maybeSingle()
  if (v.error || (v.data?.media_ids ?? []).length) return false
  const r = await db().rpc('tl_attach_photos', { p_plan_id: plan.id, p_expected_version_no: plan.version_no })
  return !r.error && Boolean(r.data && (r.data as { id?: string }).id)
}

export async function loadPost(id: string) {
  const first = await db().from('content_plan').select(PLAN_COLS).eq('id', id).maybeSingle()
  if (first.error) throw first.error
  if (!first.data) return null
  let plan = first.data as PlanRow
  if (await autoAttachPhotos(plan)) {
    const again = await db().from('content_plan').select(PLAN_COLS).eq('id', id).maybeSingle()
    if (again.error) throw again.error
    plan = again.data as PlanRow
  }
  const [v, c, names] = await Promise.all([
    db().from('post_versions').select('*').eq('content_plan_id', id).order('version_no', { ascending: true }),
    db().from('review_comments').select('id, version_id, target, body, chips, source, status, created_at').eq('content_plan_id', id).order('created_at', { ascending: true }),
    namesFor([plan]),
  ])
  if (v.error) throw v.error
  if (c.error) throw c.error
  const versions = (v.data ?? []) as VersionRow[]
  const [media, hotelPhotos, need] = await Promise.all([
    mediaViews(versions.flatMap((x) => x.media_ids ?? [])).catch(() => ({})),
    hotelPhotoCount(plan.hotel_id),
    db().rpc('tl_photo_count', { p_platform: plan.platform, p_slot_type: plan.slot_type, p_pillar: plan.pillar }),
  ])
  return {
    plan,
    hotel: plan.hotel_id ? names.hotels.get(plan.hotel_id) ?? null : null,
    tour: plan.tour_id ? names.tours.get(plan.tour_id) ?? null : null,
    versions,
    comments: (c.data ?? []) as CommentRow[],
    media,
    photo_need: need.error ? 0 : Number(need.data ?? 0),
    hotel_photos: hotelPhotos,
  }
}

// Повідомити n8n (Review Action). Без налаштованого вебхука правка лишається «changes_requested» — її підхопить Влад
export async function notifyN8n(payload: Record<string, unknown>): Promise<boolean> {
  const secret = process.env.N8N_WEBHOOK_SECRET
  const s = await getSettings(['n8n_webhook_base'])
  const base = typeof s.n8n_webhook_base === 'string' ? s.n8n_webhook_base.replace(/\/$/, '') : ''
  if (!base || !secret) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(`${base}/travellab-review-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Secret': secret },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

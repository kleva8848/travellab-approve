import { isDemo, tg } from './tg'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const TIMEOUT_MS = 15_000

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${tg?.initData ?? ''}`, ...init?.headers },
    })
  } catch {
    throw new ApiError(0, 'Немає звʼязку з сервером. Перевір інтернет і спробуй ще раз.')
  } finally {
    clearTimeout(timer)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.tg_id ? `TG ID ${body.tg_id}` : body.error ?? res.statusText)
  return body as T
}

export type Me = { id: number; first_name?: string; username?: string; is_admin: boolean }

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

export async function getMe(): Promise<Me> {
  if (isDemo) {
    await wait()
    return { id: 1, first_name: 'Іра', is_admin: false }
  }
  const r = await call<{ user: Me }>('/api/me')
  return r.user
}

// ───────────── Фаза 3: черга і огляд постів ─────────────

export type ReviewStatus =
  | 'planned' | 'generating' | 'needs_data' | 'ready_for_review' | 'changes_requested' | 'regenerating'
  | 'approved' | 'published' | 'skipped' | 'missed' | 'failed' | 'backlog'

export type Plan = {
  id: string
  day: string
  platform: 'telegram' | 'instagram' | 'threads' | string
  slot_type: string
  pillar: string
  tour_id: string | null
  hotel_id: string | null
  scheduled_for: string | null
  slot_time: string | null
  review_status: ReviewStatus
  version_no: number
  current_version_id: string | null
  approved_at: string | null
  published_at: string | null
}

export type QueueItem = Plan & { hotel_name: string | null; tour_title: string | null; preview: string }

export type Version = {
  id: string
  version_no: number
  text_v: number
  image_v: number
  text: string | null
  hooks: string[] | null
  form: string | null
  key_idea: string | null
  trigger: string
  comment_id: string | null
  media_ids: string[]
  prompt_version: string | null
  lint: { note?: string } | null
  missing_facts: { field?: string; note?: string }[] | null
  created_at: string
}

export type Comment = { id: string; version_id: string | null; target: 'text' | 'photo'; body: string; status: string; created_at: string }

export type MediaView = { media_id: string; url: string | null; description: string | null; width: number | null; height: number | null }

export type PostDetail = {
  plan: Plan
  hotel: { hotel_id: string; name: string; country: string } | null
  tour: { tour_id: string; title: string; destination: string; price_range: string | null; dates_example: string | null } | null
  versions: Version[]
  comments: Comment[]
  media: Record<string, MediaView>
  photo_need: number
  hotel_photos: number
}

export type CommentInput = { text: string; photo: string; chips_text: string[]; chips_photo: string[] }

export async function getQueue(): Promise<QueueItem[]> {
  if (isDemo) {
    await wait()
    return demo.queue()
  }
  return (await call<{ items: QueueItem[] }>('/api/queue')).items
}

export async function getPost(id: string): Promise<PostDetail> {
  if (isDemo) {
    await wait()
    return demo.post(id)
  }
  return call<PostDetail>(`/api/post?id=${encodeURIComponent(id)}`)
}

export async function reviewAction(
  id: string,
  expected_version_no: number,
  action: 'approve' | 'unapprove' | 'comment' | 'restore' | 'swap_photo',
  extra: Partial<CommentInput> & { version_id?: string; slide_idx?: number } = {},
): Promise<{ ok: true; queued?: boolean; swapped?: boolean }> {
  if (isDemo) {
    await wait(400)
    return demo.act(id, action, extra)
  }
  return call('/api/review', { method: 'POST', body: JSON.stringify({ id, expected_version_no, action, ...extra }) })
}

// ───────────── Демо (?demo=1): вигадані дані, лише щоб показати екрани ─────────────
const demo = (() => {
  const now = new Date().toISOString()
  // Демо-фото: градієнти замість справжніх (url null → плейсхолдер у каруселі)
  const pool = ['D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6']
  const media = Object.fromEntries(pool.map((m, i) => [m, { media_id: m, url: null, description: `Демо-фото ${i + 1}`, width: 1200, height: 1500 }]))
  const mk = (id: string, day: string, platform: string, pillar: string, hotel: string | null, texts: string[], status: ReviewStatus, comment?: string, photos: string[] = []): PostDetail => ({
    plan: {
      id, day, platform, slot_type: 'demo', pillar, tour_id: null, hotel_id: hotel ? 'HTL-000' : null, scheduled_for: null, slot_time: null,
      review_status: status, version_no: texts.length, current_version_id: `${id}-v${texts.length}`, approved_at: null, published_at: null,
    },
    hotel: hotel ? { hotel_id: 'HTL-000', name: hotel, country: '—' } : null,
    tour: null,
    versions: texts.map((text, i) => ({
      id: `${id}-v${i + 1}`, version_no: i + 1, text_v: i + 1, image_v: 0, text, hooks: null, form: 'one_fact',
      key_idea: 'Демо: головна думка поста', trigger: i ? 'comment' : 'initial', comment_id: i && comment ? `${id}-c1` : null,
      media_ids: photos,
      prompt_version: 'demo', lint: null, missing_facts: [], created_at: now,
    })),
    comments: comment ? [{ id: `${id}-c1`, version_id: `${id}-v1`, target: 'text', body: comment, status: 'applied', created_at: now }] : [],
    media,
    photo_need: hotel ? photos.length || 1 : 0,
    hotel_photos: hotel && photos.length ? pool.length : 0,
  })
  const posts: PostDetail[] = [
    mk('d1', 'Пн', 'instagram', 'hotel_place', 'Демо-готель на острові', [
      'Коли родина обирає острів, я завжди питаю одне: а що робитиме дитина між сніданком і вечерею?\n\nТут відповідь проста — риф поруч з берегом. Маску можна взяти одразу після сніданку, без човна й без розкладу.\n\nДеталі на ваші дати — пишіть у приват.',
      'Коли родина обирає острів, я питаю: а що робитиме дитина між сніданком і вечерею?\n\nТут відповідь — риф поруч з берегом. Маска після сніданку, без човна й без розкладу.\n\nДеталі на ваші дати — пишіть у приват.',
    ], 'ready_for_review', 'Коротше, без «я завжди»', ['D-1', 'D-2', 'D-3']),
    mk('d2', 'Ср', 'telegram', 'insider', 'Демо-курорт у Греції', [
      '**Осінь — і басейн досі чекає на плавання.**\n\nВода підігріта, тож навіть у жовтні не виникає питання, чи вдасться поплавати. Для поїздок у shoulder season це сильна перевага.\n\n→ @demo',
    ], 'ready_for_review', undefined, []),
    mk('d3', 'Пт', 'threads', 'personal_take', null, [
      'Є готель, за яким я зараз уважно спостерігаю. З висновками не поспішаю — хочу побачити, як він покаже себе в перший сезон.',
    ], 'approved'),
  ]
  const byId = (id: string) => {
    const p = posts.find((x) => x.plan.id === id)
    if (!p) throw new ApiError(404, 'not found')
    return p
  }
  return {
    queue: (): QueueItem[] =>
      posts.map((p) => ({
        ...p.plan, hotel_name: p.hotel?.name ?? null, tour_title: null,
        preview: (p.versions.at(-1)?.text ?? '').replace(/\*\*/g, '').slice(0, 140),
      })),
    post: (id: string): PostDetail => structuredClone(byId(id)),
    act: (id: string, action: string, extra: Partial<CommentInput> & { version_id?: string; slide_idx?: number }) => {
      const p = byId(id)
      if (action === 'approve') { p.plan.review_status = 'approved'; p.plan.approved_at = new Date().toISOString() }
      if (action === 'swap_photo') {
        const prev = p.versions.at(-1)!
        const ids = [...prev.media_ids]
        const free = pool.filter((m) => !ids.includes(m))
        ids[extra.slide_idx ?? 0] = free[Math.floor(Math.random() * free.length)]
        const n = p.versions.length + 1
        p.versions.push({ ...prev, id: `${id}-v${n}`, version_no: n, image_v: prev.image_v + 1, trigger: 'photo_edit', comment_id: null, media_ids: ids })
        Object.assign(p.plan, { version_no: n, current_version_id: `${id}-v${n}` })
        return { ok: true as const, swapped: true }
      }
      if (action === 'unapprove') { p.plan.review_status = 'ready_for_review'; p.plan.approved_at = null }
      if (action === 'restore') {
        const old = p.versions.find((v) => v.id === extra.version_id)
        if (old) {
          const n = p.versions.length + 1
          p.versions.push({ ...old, id: `${id}-v${n}`, version_no: n, trigger: 'manual', comment_id: null })
          Object.assign(p.plan, { version_no: n, current_version_id: `${id}-v${n}`, review_status: 'ready_for_review' })
        }
      }
      if (action === 'comment') {
        const cid = `${id}-c${p.comments.length + 1}`
        const body = [extra.text, extra.photo].filter(Boolean).join(' · ')
        p.comments.push({ id: cid, version_id: p.plan.current_version_id, target: extra.text ? 'text' : 'photo', body, status: 'processing', created_at: new Date().toISOString() })
        p.plan.review_status = 'regenerating'
        // Демо: «агент» відповідає за 4 с
        setTimeout(() => {
          const prev = p.versions.at(-1)!
          const n = p.versions.length + 1
          p.versions.push({ ...prev, id: `${id}-v${n}`, version_no: n, text_v: prev.text_v + 1, trigger: 'comment', comment_id: cid, text: (prev.text ?? '').split('\n\n').slice(0, 2).join('\n\n') })
          Object.assign(p.plan, { version_no: n, current_version_id: `${id}-v${n}`, review_status: 'ready_for_review' })
          p.comments.at(-1)!.status = 'applied'
        }, 4000)
        return { ok: true as const, queued: true }
      }
      return { ok: true as const }
    },
  }
})()

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

// inquiries — «💬 Написали з цього поста» (лише викладені; нема поля — кнопку не показуємо)
export type QueueItem = Plan & { hotel_name: string | null; tour_title: string | null; preview: string; questions?: number; inquiries?: number }

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
  is_golden?: boolean
  render_params?: RenderParams | null
  created_at: string
}

export type PhotoEdit = { text?: 'off' | 'top' | 'bottom'; look?: 'none'; crop?: 'centre' | 'north' | 'south'; title?: string; kicker?: string }
export type RenderParams = {
  photo_text?: { title?: string; kicker?: string }
  photo_captions?: { items?: ({ title?: string } | null)[] }
  photo_edits?: Record<string, PhotoEdit>
}

export type Comment = { id: string; version_id: string | null; target: 'text' | 'photo'; body: string; status: string; created_at: string }

export type MediaView = { media_id: string; url: string | null; description: string | null; width: number | null; height: number | null }

// «Бракує даних»: питання агента, на які чекаємо відповідь Іри
export type Question = { id: string; field: string | null; question: string; why_needed: string | null }

export type PostDetail = {
  plan: Plan
  hotel: { hotel_id: string; name: string; country: string } | null
  tour: { tour_id: string; title: string; destination: string; price_range: string | null; dates_example: string | null } | null
  versions: Version[]
  comments: Comment[]
  media: Record<string, MediaView>
  photo_need: number
  hotel_photos: number
  questions?: Question[]
  // посилання в бот «Відповісти голосом»; null — голос через бот ще не ввімкнено
  voice_link?: string | null
  inquiries?: number
}

export type CommentInput = { text: string; photo: string; chips_text: string[]; chips_photo: string[] }

type ActionExtra = { answers?: { id: string; answer: string }[]; version_id?: string; slide_idx?: number; path?: string; mode?: 'replace' | 'add'; width?: number; height?: number; preview?: string; date?: string; time?: string; on?: boolean; media_id?: string; edit?: { [K in keyof PhotoEdit]?: PhotoEdit[K] | null } }
type ActionResult = { ok: true; inquiries?: number; queued?: boolean; remaining?: number; swapped?: boolean; path?: string; signed_url?: string; media_id?: string; photos?: number; photo_text?: string | null; version_no?: number; urls?: (string | null)[]; plan?: { scheduled_for?: string | null; slot_time?: string | null } }

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
  action: 'approve' | 'unapprove' | 'comment' | 'restore' | 'swap_photo' | 'upload_url' | 'add_photo' | 'send_to_chat' | 'edit_text' | 'publish' | 'unpublish' | 'preview' | 'reschedule' | 'skip' | 'golden' | 'photo_edit' | 'send_story' | 'answer_data' | 'inquiry',
  extra: Partial<CommentInput> & ActionExtra = {},
): Promise<ActionResult> {
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
      review_status: status, version_no: texts.length, current_version_id: texts.length ? `${id}-v${texts.length}` : null, approved_at: null, published_at: status === 'published' ? now : null,
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
    { ...mk('d4', 'Чт', 'instagram', 'hotel_place', 'Демо-вілла на Санторіні', [], 'needs_data'),
      questions: [
        { id: 'q1', field: 'key_detail', question: 'Чим Демо-вілла на Санторіні відрізняється від схожих готелів? Одна головна деталь', why_needed: 'Пост будується навколо однієї деталі — без неї вийдуть загальні слова' },
        { id: 'q2', field: 'who_for', question: 'Кому Демо-вілла на Санторіні підходить найбільше? Наприклад: сімʼї з малюками, пари', why_needed: 'Щоб пост говорив до правильних людей' },
      ],
      voice_link: 'https://t.me/travellab_studio_bot?start=answer_d4' },
    mk('d3', 'Пт', 'threads', 'personal_take', null, [
      'Є готель, за яким я зараз уважно спостерігаю. З висновками не поспішаю — хочу побачити, як він покаже себе в перший сезон.',
    ], 'approved'),
    { ...mk('d5', 'Нд', 'telegram', 'hotel_place', 'Демо-готель на атолі', [
      'Тут найцінніше — тиша після восьмої вечора. Ресторан закривається рано, і острів належить гостям.\n\nДеталі на ваші дати — пишіть у приват.',
    ], 'published'), inquiries: 2 },
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
        preview: p.plan.review_status === 'needs_data' && p.questions?.length ? p.questions[0].question : (p.versions.at(-1)?.text ?? '').replace(/\*\*/g, '').slice(0, 140),
        questions: p.plan.review_status === 'needs_data' ? p.questions?.length ?? 0 : 0,
        ...(p.plan.review_status === 'published' ? { inquiries: p.inquiries ?? 0 } : {}),
      })),
    post: (id: string): PostDetail => structuredClone(byId(id)),
    act: (id: string, action: string, extra: Partial<CommentInput> & ActionExtra): ActionResult => {
      const p = byId(id)
      if (action === 'approve') {
        p.plan.review_status = 'approved'; p.plan.approved_at = new Date().toISOString()
        p.plan.scheduled_for ??= new Date(Date.now() + 864e5).toISOString().slice(0, 10)
        p.plan.slot_time ??= ({ telegram: '10:00', instagram: '19:00', threads: '13:00' } as Record<string, string>)[p.plan.platform] ?? '12:00'
        return { ok: true as const, plan: { scheduled_for: p.plan.scheduled_for, slot_time: p.plan.slot_time } }
      }
      if (action === 'reschedule') { p.plan.scheduled_for = extra.date ?? null; p.plan.slot_time = extra.time ?? null; return { ok: true as const } }
      if (action === 'upload_url') return { ok: true as const, path: `uploads/${id}/demo.jpg`, signed_url: '' }
      if (action === 'edit_text') {
        const prev = p.versions.at(-1)!
        const v = { ...prev, id: `demo-v${prev.version_no + 1}`, version_no: prev.version_no + 1, text_v: prev.text_v + 1, text: extra.text ?? prev.text, trigger: 'manual', prompt_version: 'ira_edit', created_at: new Date().toISOString() }
        p.versions.push(v); p.plan.version_no = v.version_no; p.plan.current_version_id = v.id
        return { ok: true as const }
      }
      if (action === 'publish') { p.plan.review_status = 'published'; p.plan.published_at = new Date().toISOString() }
      if (action === 'unpublish') { p.plan.review_status = 'approved'; p.plan.published_at = null }
      if (action === 'preview') return { ok: true as const, version_no: p.plan.version_no, urls: [] }
      if (action === 'send_story') return { ok: true as const, photos: 1 }
      if (action === 'send_to_chat') return { ok: true as const, photos: p.versions.at(-1)?.media_ids.length ?? 0 }
      if (action === 'add_photo') {
        const prev = p.versions.at(-1)!
        const mid = `U-${p.versions.length + 1}`
        p.media[mid] = { media_id: mid, url: extra.preview ?? null, description: 'Твоє фото', width: extra.width ?? null, height: extra.height ?? null }
        const ids = [...prev.media_ids]
        if (extra.mode === 'replace' && extra.slide_idx !== undefined && extra.slide_idx < ids.length) ids[extra.slide_idx] = mid
        else ids.push(mid)
        const n = p.versions.length + 1
        p.versions.push({ ...prev, id: `${id}-v${n}`, version_no: n, image_v: prev.image_v + 1, trigger: 'own_photo', comment_id: null, media_ids: ids })
        Object.assign(p.plan, { version_no: n, current_version_id: `${id}-v${n}` })
        return { ok: true as const, media_id: mid }
      }
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
      if (action === 'photo_edit' && extra.media_id) {
        const prev = p.versions.at(-1)!
        const edits = { ...(prev.render_params?.photo_edits ?? {}) }
        const next: Record<string, unknown> = { ...(edits[extra.media_id] ?? {}) }
        for (const [k, v] of Object.entries(extra.edit ?? {})) if (v === null) delete next[k]; else next[k] = v
        edits[extra.media_id] = next as PhotoEdit
        const n = p.versions.length + 1
        p.versions.push({ ...prev, id: `${id}-v${n}`, version_no: n, image_v: prev.image_v + 1, trigger: 'photo_edit', prompt_version: 'photo_look', comment_id: null, render_params: { ...prev.render_params, photo_edits: edits } })
        Object.assign(p.plan, { version_no: n, current_version_id: `${id}-v${n}` })
      }
      if (action === 'answer_data') {
        const got = new Set((extra.answers ?? []).map((a) => a.id))
        p.questions = (p.questions ?? []).filter((q) => !got.has(q.id))
        if (p.questions.length) return { ok: true as const, queued: false, remaining: p.questions.length }
        p.plan.review_status = 'regenerating'
        // Демо: «агент» дописує пост за 4 с
        setTimeout(() => {
          const v: Version = {
            id: `${id}-v1`, version_no: 1, text_v: 1, image_v: 0, hooks: null, form: 'one_fact', key_idea: 'Демо: вілла над кальдерою', trigger: 'data_answer',
            comment_id: null, media_ids: [], prompt_version: 'demo', lint: null, missing_facts: [], created_at: new Date().toISOString(),
            text: 'На Санторіні всі дивляться на захід сонця. Тут його видно з власного басейну — без натовпу в Ії.\n\nДля пар, які хочуть тиші й краєвиду без поспіху.\n\nДеталі на ваші дати — пишіть у приват.',
          }
          p.versions.push(v)
          Object.assign(p.plan, { version_no: 1, current_version_id: v.id, review_status: 'ready_for_review' })
        }, 4000)
        return { ok: true as const, queued: true, remaining: 0 }
      }
      if (action === 'inquiry') { p.inquiries = Math.max(0, (p.inquiries ?? 0) + (extra.on === false ? -1 : 1)); return { ok: true as const, inquiries: p.inquiries } }
      if (action === 'skip') p.plan.review_status = 'skipped'
      if (action === 'golden') { const v = p.versions.find((x) => x.id === p.plan.current_version_id); if (v) v.is_golden = extra.on !== false }
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
          // Демо: правка лише до фото, якої агент не вміє («інше фото», шрифт…) — лишається видимою, пост повертається на перегляд
          if (!extra.text && /інше фото|шрифт|лого|стиль/i.test(String(extra.photo ?? ''))) {
            p.plan.review_status = 'ready_for_review'
            p.comments.at(-1)!.status = 'new'
            return
          }
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

import { isDemo, tg } from './tg'
import { demoVideo, demoVideoGaps, demoVideos, patchDemoVideo, saveDemoVideo, type RemountJob, type VideoDraft, type VideoList, type VideoPlan } from './video'

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
    // ?demo=1&admin=1 — подивитись адмінський блок «Правила з правок»
    const admin = new URLSearchParams(location.search).has('admin')
    return { id: 1, first_name: admin ? 'Влад' : 'Іра', is_admin: admin }
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
  // WF-018: «Для кого: P3 Жінки… (хто). Питання клієнта: «…» — …» + службові вказівки агенту (розбір — lib/audience.ts)
  note?: string | null
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
// Водяний знак на фото поста: wm1 — горизонтальний (дефолт), wm3 — рукописний, off — без
export type PostWm = 'wm1' | 'wm3' | 'off'
export type RenderParams = {
  photo_text?: { title?: string; kicker?: string }
  photo_captions?: { items?: ({ title?: string } | null)[] }
  photo_edits?: Record<string, PhotoEdit>
  wm?: PostWm
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

type ActionExtra = { answers?: { id: string; answer: string }[]; version_id?: string; slide_idx?: number; path?: string; mode?: 'replace' | 'add'; width?: number; height?: number; preview?: string; date?: string; time?: string; on?: boolean; media_id?: string; edit?: { [K in keyof PhotoEdit]?: PhotoEdit[K] | null }; wm?: PostWm }
type ActionResult = { ok: true; inquiries?: number; queued?: boolean; remaining?: number; swapped?: boolean; path?: string; signed_url?: string; media_id?: string; photos?: number; photo_text?: string | null; version_no?: number; urls?: (string | null)[]; plan?: { scheduled_for?: string | null; slot_time?: string | null } }

// «🎙 Розповісти історію»: посилання в бот, підказка тижня, скільки історій у черзі
export type StoryInfo = { link: string; hint: string; queued: number }

export async function getQueue(): Promise<{ items: QueueItem[]; story: StoryInfo | null }> {
  if (isDemo) {
    await wait()
    return { items: demo.queue(), story: { link: 'https://t.me/travellab_studio_bot?start=story', hint: 'Розкажи про клієнтів, які вперше летіли так далеко. Чого боялись до поїздки — і що сказали після?', queued: 0 } }
  }
  const r = await call<{ items: QueueItem[]; story?: StoryInfo | null }>('/api/queue')
  return { items: r.items, story: r.story ?? null }
}

// Вкладка «План»: усі слоти тижня з будь-яким статусом; photos — скільки фото в поточній версії
export type PlanItem = QueueItem & { photos: number }
export type WeekPlan = { from: string; to: string; today: string; items: PlanItem[] }

export async function getPlan(week: number): Promise<WeekPlan> {
  if (isDemo) {
    await wait()
    return demo.plan(week)
  }
  return call<WeekPlan>(`/api/plan?week=${week}`)
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
  action: 'approve' | 'unapprove' | 'comment' | 'restore' | 'swap_photo' | 'upload_url' | 'add_photo' | 'send_to_chat' | 'edit_text' | 'publish' | 'unpublish' | 'preview' | 'reschedule' | 'skip' | 'golden' | 'photo_edit' | 'send_story' | 'answer_data' | 'inquiry' | 'watermark',
  extra: Partial<CommentInput> & ActionExtra = {},
): Promise<ActionResult> {
  if (isDemo) {
    await wait(400)
    return demo.act(id, action, extra)
  }
  return call('/api/review', { method: 'POST', body: JSON.stringify({ id, expected_version_no, action, ...extra }) })
}

// ───────────── Фаза 7: правила з правок Іри (лише адмін) ─────────────

export type Rule = { id: string; rule_text: string; scope: 'global' | 'platform' | 'pillar' | 'hotel'; where: string; created_at: string; source: string | null }
export type RuleDecision = 'approve' | 'reject' | 'disable'

const demoRules: { pending: Rule[]; active: Rule[] } = {
  pending: [
    { id: 'r1', rule_text: 'Пиши просто й природно, без складних зворотів.', scope: 'global', where: 'усі пости', created_at: new Date().toISOString(), source: 'Можна написати природніше, без складних заворотів' },
  ],
  active: [
    { id: 'r2', rule_text: 'Не подавай кам\'янистий пляж Демо-готелю як мінус.', scope: 'hotel', where: 'Демо-готель на острові', created_at: new Date().toISOString(), source: null },
    { id: 'r3', rule_text: 'У кінці поста без стрілки перед контактом.', scope: 'platform', where: 'Telegram', created_at: new Date().toISOString(), source: null },
  ],
}

export async function getRules(): Promise<{ pending: Rule[]; active: Rule[] }> {
  if (isDemo) {
    await wait()
    return structuredClone(demoRules)
  }
  return call('/api/rules')
}

export async function decideRule(id: string, decision: RuleDecision): Promise<void> {
  if (isDemo) {
    await wait(300)
    const from = decision === 'disable' ? demoRules.active : demoRules.pending
    const i = from.findIndex((r) => r.id === id)
    if (i >= 0) {
      const [r] = from.splice(i, 1)
      if (decision === 'approve') demoRules.active.unshift(r)
    }
    return
  }
  await call('/api/rules', { method: 'POST', body: JSON.stringify({ id, decision }) })
}

// ───────────── Аудиторії: портрети + питання клієнтів для плану тижня (WF-018) ─────────────

export type AudienceQuestion = { id: string; audience_id: string; question: string; with_hotel: boolean; active: boolean; sort_order: number }
export type AudienceItem = { id: string; code: string; name: string; who: string; match_words: string; active: boolean; sort_order: number; questions: AudienceQuestion[] }
export type Audiences = { audiences: AudienceItem[]; next_focus_id: string | null }
export type AudienceAction =
  | { action: 'audience_save'; id?: string; name: string; who: string; match_words?: string }
  | { action: 'audience_active'; id: string; active: boolean }
  | { action: 'question_save'; id?: string; audience_id?: string; question: string; with_hotel: boolean }
  | { action: 'question_active'; id: string; active: boolean }

const demoAud: Audiences = {
  audiences: [
    { id: 'a1', code: 'P1', name: 'Пара з приводом', who: 'пара 35–45, ювілей / подарунок / романтика, без дітей', match_words: 'couple, romant, пар', active: true, sort_order: 1, questions: [
      { id: 'q1', audience_id: 'a1', question: 'Куди поїхати вдвох на ювілей, щоб було і красиво, і не нудно?', with_hotel: true, active: true, sort_order: 1 },
      { id: 'q2', audience_id: 'a1', question: 'За скільки планувати подорож-подарунок на дату?', with_hotel: false, active: true, sort_order: 2 },
    ] },
    { id: 'a2', code: 'P2', name: 'Багатодітна сім\'я', who: 'сім\'я з 2–4 дітьми; вілли / connecting rooms', match_words: 'family, kids', active: true, sort_order: 2, questions: [
      { id: 'q3', audience_id: 'a2', question: 'Чим будуть зайняті діти різного віку, поки батьки відпочивають?', with_hotel: true, active: true, sort_order: 1 },
    ] },
  ],
  next_focus_id: 'a2',
}

export async function getAudiences(): Promise<Audiences> {
  if (isDemo) {
    await wait()
    return structuredClone(demoAud)
  }
  return call('/api/audiences')
}

export async function audienceAction(a: AudienceAction): Promise<Audiences> {
  if (isDemo) {
    await wait(300)
    const all = demoAud.audiences
    if (a.action === 'audience_save') {
      const x = all.find((y) => y.id === a.id)
      if (x) Object.assign(x, { name: a.name, who: a.who, match_words: a.match_words ?? x.match_words })
      else all.push({ id: `a${Date.now()}`, code: `P${all.length + 1}`, name: a.name, who: a.who, match_words: '', active: true, sort_order: all.length + 1, questions: [] })
    }
    if (a.action === 'audience_active') {
      const x = all.find((y) => y.id === a.id)
      if (x) x.active = a.active
    }
    if (a.action === 'question_save') {
      const x = all.flatMap((y) => y.questions).find((y) => y.id === a.id)
      if (x) Object.assign(x, { question: a.question, with_hotel: a.with_hotel })
      else all.find((y) => y.id === a.audience_id)?.questions.push({ id: `q${Date.now()}`, audience_id: a.audience_id ?? '', question: a.question, with_hotel: a.with_hotel, active: true, sort_order: 99 })
    }
    if (a.action === 'question_active') {
      const x = all.flatMap((y) => y.questions).find((y) => y.id === a.id)
      if (x) x.active = a.active
    }
    return structuredClone(demoAud)
  }
  return call('/api/audiences', { method: 'POST', body: JSON.stringify(a) })
}

// ───────────── Сторіз / рілс (SQL 018, /api/video) ─────────────

export async function getVideos(): Promise<VideoList> {
  if (isDemo) return { items: demoVideos(), gaps: demoVideoGaps }
  const r = await call<Partial<VideoList>>('/api/video')
  return { items: r.items ?? [], gaps: r.gaps ?? [] }
}

export async function getVideo(id: string): Promise<VideoDraft> {
  if (isDemo) {
    await wait(150)
    return demoVideo(id)
  }
  const r = await call<{ video: VideoDraft }>(`/api/video?id=${encodeURIComponent(id)}`)
  return r.video
}

export type VideoAction = 'save' | 'approve' | 'unapprove' | 'skip'

export async function videoAction(d: VideoDraft, action: VideoAction, plan?: VideoPlan): Promise<{ status: VideoDraft['status']; updated_at: string }> {
  if (isDemo) {
    await wait(200)
    const status = action === 'approve' ? 'approved' : action === 'unapprove' ? 'ready_for_review' : action === 'skip' ? 'skipped' : d.status
    // у демо «воркер» монтує миттєво — щоб було видно «готово ✓» і «Надіслати ще раз»
    const now = new Date().toISOString()
    saveDemoVideo({ ...d, ...plan, status, final: status === 'approved' ? { rendered_at: now, sent_at: now } : null })
    return { status, updated_at: now }
  }
  return call('/api/video', { method: 'POST', body: JSON.stringify({ action, id: d.id, plan, expected_updated_at: action === 'save' ? d.updated_at : undefined }) })
}

// Готове відео ще раз у чат (SQL 019) — тому, хто натиснув
export async function resendVideo(id: string): Promise<{ sent_at: string }> {
  if (isDemo) {
    await wait(300)
    return { sent_at: new Date().toISOString() }
  }
  return call('/api/video', { method: 'POST', body: JSON.stringify({ action: 'resend', id }) })
}

// Підпис до поста (SQL 022): окремо від плану — готове відео не скидається
export async function saveVideoCaption(id: string, caption: string): Promise<{ caption: string }> {
  if (isDemo) {
    await wait(200)
    patchDemoVideo(id, { caption })
    return { caption }
  }
  return call('/api/video', { method: 'POST', body: JSON.stringify({ action: 'caption', id, caption }) })
}

// «✅ Виклала» (Instagram — Іра викладає сама; те саме робить кнопка в боті)
export async function markVideoPosted(id: string): Promise<{ published_at: string }> {
  if (isDemo) {
    await wait(200)
    const published_at = new Date().toISOString()
    patchDemoVideo(id, { published_at })
    return { published_at }
  }
  return call('/api/video', { method: 'POST', body: JSON.stringify({ action: 'posted', id }) })
}

// Перемонтаж кадрів (SQL 020): заявка воркеру → { status, updated_at }; стан потім — getVideo(id).remount
export async function remountVideo(d: VideoDraft, job: RemountJob): Promise<{ status: VideoDraft['status']; updated_at: string }> {
  if (isDemo) {
    await wait(200)
    throw new Error('У демо кадри не перемонтовуються — це працює лише зі справжніми відео')
  }
  return call('/api/video', { method: 'POST', body: JSON.stringify({ action: 'remount', id: d.id, ...job, expected_updated_at: d.updated_at }) })
}

// Іра прочитала підсумок перемонтажу — більше не показуємо
export async function ackRemount(id: string): Promise<void> {
  if (isDemo) return
  await call('/api/video', { method: 'POST', body: JSON.stringify({ action: 'remount_ok', id }) })
}

// ───────────── Демо (?demo=1): вигадані дані, лише щоб показати екрани ─────────────
const DEMO_NOTE: Record<string, string> = {
  d1: 'Для кого: P2 Багатодітна сім\'я (сім\'я з 2–4 дітьми; потрібна сімейна інфраструктура, вілли / connecting rooms). Питання клієнта: «Чим будуть зайняті діти різного віку, поки батьки відпочивають?» — відповідай цій людині на прикладі цього готелю. Поїздки на 1–3 міс.',
  d2: 'Для кого: P3 Жінки в подорожі (дві подруги або мама з дочкою; короткі поїздки, комфорт, spa). Питання клієнта: «Куди поїхати з подругою на 5 днів, щоб відпочити по-справжньому?» — відповідай цій людині на прикладі цього готелю.',
}
const demo = (() => {
  const now = new Date().toISOString()
  // Демо-фото: градієнти замість справжніх (url null → плейсхолдер у каруселі)
  const pool = ['D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6']
  const media = Object.fromEntries(pool.map((m, i) => [m, { media_id: m, url: null, description: `Демо-фото ${i + 1}`, width: 1200, height: 1500 }]))
  const mk = (id: string, day: string, platform: string, pillar: string, hotel: string | null, texts: string[], status: ReviewStatus, comment?: string, photos: string[] = []): PostDetail => ({
    plan: {
      id, day, platform, slot_type: 'demo', pillar, tour_id: null, hotel_id: hotel ? 'HTL-000' : null, scheduled_for: null, slot_time: null,
      review_status: status, version_no: texts.length, current_version_id: texts.length ? `${id}-v${texts.length}` : null, approved_at: null, published_at: status === 'published' ? now : null, note: DEMO_NOTE[id] ?? null,
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
    // Демо-план: пости розкладено по днях поточного тижня + 2 слоти, які агент ще не написав
    plan: (week: number): WeekPlan => {
      const d0 = new Date()
      const dow = (d0.getDay() + 6) % 7
      const day = (n: number) => { const d = new Date(d0); d.setDate(d0.getDate() - dow + 7 * week + n); return d.toISOString().slice(0, 10) }
      const DOW: Record<string, number> = { 'Пн': 0, 'Вт': 1, 'Ср': 2, 'Чт': 3, 'Пт': 4, 'Сб': 5, 'Нд': 6 }
      const TIME: Record<string, string> = { telegram: '10:00', instagram: '19:00', threads: '13:00' }
      const items: PlanItem[] = posts.map((p) => ({
        ...p.plan, scheduled_for: day(DOW[p.plan.day] ?? 0), slot_time: TIME[p.plan.platform] ?? '12:00', slot_type: p.plan.platform === 'instagram' ? 'feed_carousel' : 'content',
        hotel_name: p.hotel?.name ?? null, tour_title: null, preview: (p.versions.at(-1)?.text ?? '').replace(/\*\*/g, '').slice(0, 140), photos: p.versions.at(-1)?.media_ids.length ?? 0,
      }))
      const empty = (id: string, d: string, platform: string, slot_type: string, pillar: string, hotel: string | null, note: string | null): PlanItem => ({
        id, day: d, platform, slot_type, pillar, tour_id: null, hotel_id: hotel ? 'HTL-000' : null, scheduled_for: day(DOW[d]), slot_time: TIME[platform], review_status: 'planned',
        version_no: 0, current_version_id: null, approved_at: null, published_at: null, note, hotel_name: hotel, tour_title: null, preview: '', photos: 0,
      })
      items.push(
        empty('p1', 'Вт', 'instagram', 'reel', 'video', null, null),
        empty('p2', 'Сб', 'telegram', 'feed_carousel', 'unusual_hotels', 'Демо-готель на дереві', 'Для кого: P2 Багатодітна сім\'я (сім\'я з 2–4 дітьми). рубрика «Незвичайні готелі», карусель'),
      )
      items.sort((a, b) => `${a.scheduled_for}${a.slot_time}`.localeCompare(`${b.scheduled_for}${b.slot_time}`))
      return { from: day(0), to: day(6), today: new Date().toISOString().slice(0, 10), items }
    },
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
      if (action === 'watermark' && extra.wm) {
        const prev = p.versions.at(-1)!
        const n = p.versions.length + 1
        p.versions.push({ ...prev, id: `${id}-v${n}`, version_no: n, image_v: prev.image_v + 1, trigger: 'photo_edit', prompt_version: 'photo_look', comment_id: null, render_params: { ...prev.render_params, wm: extra.wm } })
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

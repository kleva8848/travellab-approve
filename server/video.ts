import { db, getSettings } from './http.js'
import { tgCall } from './publish.js'
import { videoMode } from './publish_plan.js'
import { kyivNow } from './schedule.js'
import { COVER_Y, COVER_Y_MAX, COVER_Y_MIN, coverJpeg } from './video_layers.js'

// Сторіз / рілс: чернетки з таблиці video_drafts (SQL 018). Файли — у приватному bucket `video` (signed URL на 2 год).
// План шарів (texts / wm / cover) — той самий формат, що src/lib/video.ts (VideoDraft без файлів і статусу).

const BUCKET = 'video'
const TTL_SEC = 2 * 60 * 60
const VH = 1920

const STYLES = new Set(['hook', 'title', 'word', 'num', 'sub', 'label'])
const FONTS = new Set(['cormorant', 'tenor', 'hand'])  // брендові шрифти рядка (src/lib/video.ts FONT)
const WM_KINDS = new Set(['wm2', 'wm1', 'wm3', 'off'])
const WM_POS = new Set(['br', 'tr', 'bl', 'tl'])

// start / dur / speed — шматок оригіналу (секунди вихідного кліпу); src_* — легке прев'ю всього кліпу з тим самим кропом
// і стрічка мініатюр (воркер montage-test/remount_worker.py, src_pass) — для «Обрати момент»
type ShotRow = {
  t0: number; t1: number; label: string; file?: string; thumb_path: string
  start?: number; dur?: number; speed?: number; src_path?: string; src_strip?: string; src_dur?: number
}
type DraftRow = {
  id: string; name: string; format: string; platform: string; place: string; hotel_id: string | null; dur: number | string
  web_path: string; poster_path: string; shots: ShotRow[]; plan: Plan; status: string; scheduled_for: string | null; updated_at: string
  final_path: string | null; cover_path: string | null; rendered_at: string | null; render_error: string | null; sent_at: string | null
  remount: Remount | null
  montage: Montage | null
  // публікація (сет 7, SQL 022, server/video_publish.ts)
  caption: string | null; nomusic_path: string | null; delivered_at: string | null; published_at: string | null
  published_ref: { via?: string; posted_via?: string } | null
  // окрема обкладинка (SQL 025): що намальовано + чисті кадри-кандидати (montage-test/cover.py)
  cover_spec: CoverSpec | null; cover_cands: CoverCand[] | null
}
// Звук (сет 6, montage-test/music.py): трек Mixkit + точка старту; голос Іри з бота (file_id, тривалість після очистки)
type Montage = { music?: { title: string; artist: string; mood: string } | null; voice?: { dur: number } | null }
// Заявка на перемонтаж кадрів (SQL 020) — виконує montage-test/remount_worker.py
type Remount = { kind: string; shot?: number; order?: number[]; start?: number; state: 'queued' | 'running' | 'done' | 'error'; at: string; by: number; error?: string; note?: string[] }
type VLine = { text: string; style: string; gold: number[]; maxW?: number; font?: string }
type VText = { id: string; from: number; to: number; y: number; scrim: number; lines: VLine[]; sec?: [number, number] }
export type Plan = { texts: VText[]; wm: { kind: string; pos: string; color: string }; cover: number }
// Обкладинка (SQL 025, сет 2): фон — чистий кадр (t секунд clean.mp4), kicker — надпис зверху, title — «*золоте* слово», y — висота центру тексту.
// bg.kind 'media' (сет 3) — фото з бази (таблиця media, bucket post-media) замість кадру відео
export type CoverBg = { kind: 'frame'; t: number } | { kind: 'media'; media_id: string }
export type CoverSpec = { bg: CoverBg; kicker: string; title: string; y: number; wm: Plan['wm'] }
type CoverCand = { path: string; t: number; sharp?: number }

const COLS = 'id, name, format, platform, place, hotel_id, dur, web_path, poster_path, shots, plan, status, scheduled_for, updated_at, final_path, cover_path, rendered_at, render_error, sent_at, remount, montage, caption, nomusic_path, delivered_at, published_at, published_ref, cover_spec, cover_cands'

// Фінал (SQL 019, montage-test/final_worker.py) застарів після будь-якої правки / зміни статусу → воркер рендерить заново
// (і надіслане Ірі в чат для Instagram — нове відео прийде ще раз; SQL 022)
export const FINAL_RESET = {
  final_path: null, cover_path: null, rendered_at: null, render_error: null, tg_file_id: null, sent_at: null, sent_to: null,
  nomusic_path: null, delivered_at: null, publish_slot: null, published_ref: null,
}
export const CAPTION_MAX = 2200 // ліміт підпису Instagram

// Куди піде відео в слот: TG-канал автоматом чи Ірі в чат (як server/video_publish.ts)
async function channelOn(): Promise<boolean> {
  const s = await getSettings(['autopublish_tg', 'tg_channel_id'])
  return s.autopublish_tg === 'on' && s.tg_channel_id != null && String(s.tg_channel_id).trim() !== ''
}

async function sign(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  if (!unique.length) return new Map()
  const r = await db().storage.from(BUCKET).createSignedUrls(unique, TTL_SEC)
  if (r.error) throw r.error
  return new Map((r.data ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path as string, s.signedUrl as string]))
}

// Рядок → VideoDraft для апки (файли — signed URL)
function view(d: DraftRow, urls: Map<string, string>, channel: boolean) {
  const plan = d.plan ?? ({} as Plan)
  return {
    id: d.id, name: d.name, format: d.format, platform: d.platform, place: d.place, hotel_id: d.hotel_id, dur: Number(d.dur),
    video: urls.get(d.web_path) ?? '', poster: urls.get(d.poster_path) ?? '',
    shots: (d.shots ?? []).map((s) => ({
      t0: s.t0, t1: s.t1, label: s.label, thumb: urls.get(s.thumb_path) ?? '',
      src: s.src_path && s.src_strip && urls.has(s.src_path) && s.start != null && s.dur != null ? {
        video: urls.get(s.src_path) ?? '', strip: urls.get(s.src_strip) ?? '', dur: Number(s.src_dur),
        start: Number(s.start), span: Math.round(Number(s.dur) * Number(s.speed ?? 1) * 100) / 100,
      } : null,
    })),
    texts: plan.texts ?? [], wm: plan.wm ?? { kind: 'wm2', pos: 'br', color: 'white' }, cover: plan.cover ?? 0,
    status: d.status, scheduled_for: d.scheduled_for, updated_at: d.updated_at,
    // готове відео з текстом: rendered_at — зібрано, sent_at — бот надіслав у чат; error — воркер упав (бачить Влад)
    final: d.final_path ? { rendered_at: d.rendered_at, sent_at: d.sent_at } : null,
    render_error: d.render_error,
    // перемонтаж: queued / running — монтую (текст не правиться); done + note — що сталось з текстами; error — чому ні
    remount: d.remount ? { state: d.remount.state, kind: d.remount.kind, note: d.remount.note ?? [], error: d.remount.error ?? null } : null,
    music: d.montage?.music ? { title: d.montage.music.title, artist: d.montage.music.artist, mood: d.montage.music.mood } : null,
    voice: d.montage?.voice ? { dur: Number(d.montage.voice.dur) } : null,
    // публікація: dest — куди в слот (channel — TG-канал автоматом, chat — Ірі в чат «виклади зараз»);
    // delivered_at — надіслано в чат; published_at — вийшло (канал) або Іра натиснула «✅ Виклала»
    caption: d.caption ?? '', nomusic: Boolean(d.nomusic_path), dest: videoMode(d, channel),
    delivered_at: d.delivered_at ?? null, published_at: d.published_at ?? null,
    // обкладинка: збережена спека або та, що намалював би воркер; кандидати — лише ті, що вже підписані (у списку — нема)
    cover_spec: d.cover_spec ? { ...defaultCover(d), ...d.cover_spec, y: d.cover_spec.y ?? COVER_Y } : defaultCover(d),
    cover_cands: coverCands(d).flatMap((c) => (urls.has(c.path) ? [{ t: c.t, url: urls.get(c.path) as string }] : [])),
  }
}

// «🎙 Озвучити голосом» — deep link у бот: бот просить голосове саме до цього відео (WF-055, vo_<id>).
// Як «Відповісти голосом»: лише коли бот Іри приймає повідомлення (settings.voice_answers = "on")
async function voiceLink(id: string): Promise<string | null> {
  const s = await getSettings(['voice_answers', 'bot_username'])
  const on = s.voice_answers === 'on' || s.voice_answers === true
  const bot = typeof s.bot_username === 'string' ? s.bot_username.replace(/^@/, '') : ''
  return on && bot ? `https://t.me/${bot}?start=vo_${id}` : null
}

// Список на «Сьогодні»: усе, крім пропущених; мініатюри кадрів не підписуємо — там лише постер
export async function listVideos() {
  const r = await db().from('video_drafts').select(COLS).neq('status', 'skipped').order('created_at', { ascending: false }).limit(30)
  if (r.error) throw r.error
  const rows = (r.data ?? []) as DraftRow[]
  const [urls, channel] = await Promise.all([sign(rows.map((d) => d.poster_path)), channelOn()])
  return rows.map((d) => {
    const v = view(d, urls, channel)
    return {
      id: v.id, name: v.name, format: v.format, platform: v.platform, place: v.place, dur: v.dur, poster: v.poster, status: v.status, scheduled_for: v.scheduled_for,
      ready: Boolean(v.final), remounting: v.remount?.state === 'queued' || v.remount?.state === 'running',
      dest: v.dest, delivered_at: v.delivered_at, published_at: v.published_at,
    }
  })
}

// «📹 Бракує кадрів» (SQL 021, montage-test/video_agent.py): найближчі відео-слоти, на які агент не склав чернетку.
// Без SQL 021 (нема таблиці) — порожньо, решта «Сьогодні» працює як була
export async function listVideoGaps() {
  const r = await db().from('video_slots').select('plan_id, scheduled_for, format, topic, need')
    .eq('state', 'gap').gte('scheduled_for', kyivNow().date).order('scheduled_for').limit(5)
  return r.error ? [] : r.data ?? []
}

export async function getVideo(id: string) {
  const r = await db().from('video_drafts').select(COLS).eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return 'not_found'
  const d = r.data as DraftRow
  const paths = [d.web_path, d.poster_path, ...(d.shots ?? []).flatMap((s) => [s.thumb_path, s.src_path ?? '', s.src_strip ?? '']), ...coverCands(d).map((c) => c.path)]
  const [urls, voice_link, channel] = await Promise.all([sign(paths), voiceLink(d.id), channelOn()])
  return { ...view(d, urls, channel), voice_link }
}

// published — уже вийшло: правити, перемонтовувати й повертати на перегляд пізно
export async function draftMeta(id: string): Promise<{ n: number; dur: number; remounting: boolean; published: boolean } | null> {
  const r = await db().from('video_drafts').select('shots, dur, remount, published_at').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return null
  const state = (r.data.remount as Remount | null)?.state
  return { n: ((r.data.shots ?? []) as unknown[]).length, dur: Number(r.data.dur), remounting: state === 'queued' || state === 'running', published: Boolean(r.data.published_at) }
}

export const PUBLISHED_ERR = 'Це відео вже опубліковане — змінити його не можна.'

// Підпис до поста: лише текст, без перемонтажу й без скидання готового відео (воркер підпис не рендерить)
export async function saveCaption(id: string, raw: unknown) {
  const caption = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CAPTION_MAX)
  const r = await db().from('video_drafts').update({ caption }).eq('id', id).is('published_at', null).select('id')
  if (r.error) throw r.error
  return r.data?.length ? { caption } : null
}

// ───────────── AI-правка підпису (SQL 023, n8n WF-061) ─────────────

const COMMENT_MAX = 1000
const RULES_MAX = 12
const SCOPE_ORDER: Record<string, number> = { hotel: 0, pillar: 1, platform: 2, global: 3 }
type RuleRow = { rule_text: string; scope: string; scope_value: string | null; created_at: string }

// Правила Іри з її правок (ira_rules active) — той самий відбір, що n8n/ira_rules.mjs pickIraRules для постів
async function iraRules(platform: string, hotelId: string | null, planId: string | null): Promise<string[]> {
  const [r, p] = await Promise.all([
    db().from('ira_rules').select('rule_text, scope, scope_value, created_at').eq('status', 'active'),
    planId ? db().from('content_plan').select('pillar').eq('id', planId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  if (r.error) throw r.error
  const pillar = (p.data as { pillar?: string } | null)?.pillar ?? null
  const seen = new Set<string>()
  return ((r.data ?? []) as RuleRow[])
    .filter((x) => x.scope === 'global' || (x.scope === 'platform' && x.scope_value === platform)
      || (x.scope === 'pillar' && pillar && x.scope_value === pillar) || (x.scope === 'hotel' && hotelId && x.scope_value === hotelId))
    .sort((a, b) => (SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]) || String(b.created_at).localeCompare(String(a.created_at)))
    .map((x) => x.rule_text.trim())
    .filter((t) => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true })
    .slice(0, RULES_MAX)
}

// Синхронний вебхук n8n (відповідь — JSON останнього вузла). null — n8n не налаштований / не відповів
async function n8nJson(path: string, body: Record<string, unknown>, ms: number): Promise<Record<string, unknown> | null> {
  const secret = process.env.N8N_WEBHOOK_SECRET
  const s = await getSettings(['n8n_webhook_base'])
  const base = typeof s.n8n_webhook_base === 'string' ? s.n8n_webhook_base.replace(/\/$/, '') : ''
  if (!base || !secret) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Secret': secret },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Виклик n8n «Video Caption Rewrite» (WF-061)
async function captionHook(body: Record<string, unknown>): Promise<string | null> {
  const caption = String((await n8nJson('travellab-video-caption', body, 50000))?.caption ?? '').trim()
  return caption || null
}

// Іра пише правку до підпису → AI переписує лише текст (відео не перемонтовується, final_* не скидаються).
// base — підпис з поля апки (може бути ще не збережений), інакше збережений. Правка лишається в video_caption_comments для навчання (сет 2)
export async function rewriteCaption(id: string, b: Record<string, unknown>, userId: number) {
  const comment = String(b.comment ?? '').trim().slice(0, COMMENT_MAX)
  const chips = (Array.isArray(b.chips) ? b.chips : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 10)
  if (!comment && !chips.length) return { code: 400, error: 'Напиши, що змінити в підписі.' }
  const r = await db().from('video_drafts').select('name, format, platform, place, hotel_id, plan_id, plan, caption, published_at').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return { code: 404, error: 'not found' }
  const d = r.data as { name: string; format: string; platform: string; place: string | null; hotel_id: string | null; plan_id: string | null; plan: Plan | null; caption: string | null; published_at: string | null }
  if (d.published_at) return { code: 409, error: PUBLISHED_ERR }
  const before = (typeof b.caption === 'string' ? b.caption : d.caption ?? '').trim().slice(0, CAPTION_MAX)

  const c = await db().from('video_caption_comments')
    .insert({ video_draft_id: id, body: comment || chips.join(' · '), chips, author_tg_id: userId, caption_before: before })
    .select('id').single()
  if (c.error) throw c.error

  const texts = d.plan?.texts ?? []
  const [rules, hotel] = await Promise.all([
    iraRules(d.platform, d.hotel_id, d.plan_id),
    d.hotel_id ? db().from('hotels').select('name').eq('hotel_id', d.hotel_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  const raw = await captionHook({
    caption: before, comment, chips, rules,
    name: d.name, format: d.format, platform: d.platform, place: d.place, hotel: (hotel.data as { name?: string } | null)?.name ?? null,
    screen: texts.filter((t) => !t.sec).flatMap((t) => t.lines.map((l) => l.text)).join(' / '),
    voice: texts.filter((t) => t.sec).flatMap((t) => t.lines.map((l) => l.text)).join(' '),
  })
  const caption = raw?.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CAPTION_MAX) ?? ''
  if (!caption) {
    await db().from('video_caption_comments').update({ status: 'failed' }).eq('id', c.data.id)
    return { code: 502, error: 'Агент зараз не відповів — спробуй ще раз за хвилинку. Правку не загубила.' }
  }
  const u = await db().from('video_drafts').update({ caption }).eq('id', id).is('published_at', null).select('id')
  if (u.error) throw u.error
  if (!u.data?.length) return { code: 409, error: PUBLISHED_ERR }
  await db().from('video_caption_comments').update({ status: 'applied', caption_after: caption }).eq('id', c.data.id)
  return { code: 200, caption, before }
}

// ───────────── Перемонтаж кадрів (SQL 020) ─────────────

const IDLE = 'remount.is.null,remount->>state.in.(done,error)'

// Заявка з апки → у чергу воркера. Нове відео скидає затвердження й готовий фінал; тексти воркер переназначить сам.
// Рядок мав не змінитись з моменту, коли Іра відкрила відео (expected_updated_at), і не мати заявки в роботі.
export async function requestRemount(id: string, b: Record<string, unknown>, userId: number) {
  const meta = await draftMeta(id)
  if (!meta) return { code: 404, error: 'not found' }
  if (meta.remounting) return { code: 409, error: 'Уже перемонтовую — зачекай хвилинку.' }
  if (meta.published) return { code: 409, error: PUBLISHED_ERR }
  const job: Record<string, unknown> = { kind: b.kind }
  if (b.kind === 'remove' || b.kind === 'replace' || b.kind === 'moment') {
    const shot = Number(b.shot)
    if (!Number.isInteger(shot) || shot < 0 || shot >= meta.n) return { code: 400, error: 'bad shot' }
    if (b.kind === 'remove' && meta.n < 2) return { code: 400, error: 'Це єдиний кадр — прибрати не можна.' }
    job.shot = shot
    // «Обрати момент»: секунда вихідного кліпу, з якої брати кадр (воркер підріже, щоб не вилізти за кінець)
    if (b.kind === 'moment') {
      const start = Number(b.start)
      if (!Number.isFinite(start) || start < 0 || start > 3600) return { code: 400, error: 'bad start' }
      job.start = Math.round(start * 100) / 100
    }
  } else if (b.kind === 'reorder') {
    const order = Array.isArray(b.order) ? b.order.map(Number) : []
    const perm = [...order].sort((x, y) => x - y).every((v, i) => v === i) && order.length === meta.n
    if (!perm || order.every((v, i) => v === i)) return { code: 400, error: 'bad order' }
    job.order = order
  } else if (b.kind === 'music') {
    if (typeof b.mood === 'string' && ['calm', 'romantic', 'lounge', 'breezy'].includes(b.mood)) job.mood = b.mood
  } else if (b.kind !== 'shorter' && b.kind !== 'novoice') return { code: 400, error: 'bad kind' }

  const now = new Date().toISOString()
  let q = db().from('video_drafts').update({
    remount: { ...job, state: 'queued', at: now, by: userId },
    status: 'ready_for_review', approved_at: null, approved_by: null, ...FINAL_RESET, updated_at: now,
  }).eq('id', id).neq('status', 'skipped').is('published_at', null).or(IDLE)
  if (b.expected_updated_at) q = q.eq('updated_at', String(b.expected_updated_at))
  const r = await q.select('status, updated_at')
  if (r.error) throw r.error
  if (!r.data?.length) return { code: 409, error: 'Це відео щойно змінили з іншого телефона — відкрий його ще раз.' }
  return { code: 200, ...(r.data[0] as { status: string; updated_at: string }) }
}

// Іра прочитала, що сталось після перемонтажу (або помилку) — більше не показуємо. updated_at не чіпаємо: це не правка
export async function ackRemount(id: string) {
  const r = await db().from('video_drafts').update({ remount: null }).eq('id', id).or(IDLE).select('id')
  if (r.error) throw r.error
  return Boolean(r.data?.length)
}

const num = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def
}
const int = (v: unknown, lo: number, hi: number, def: number) => Math.round(num(v, lo, hi, def))

// План з апки → чистий план (обрізаємо довжини, кадри в межах відео, стилі лише відомі). null — план не схожий на план
export function cleanPlan(raw: unknown, shots: number, dur: number): Plan | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  // до 40: субтитри голосу (сет 6) — окремий текст на кожну фразу
  if (!Array.isArray(p.texts) || p.texts.length > 40) return null
  const last = Math.max(0, shots - 1)
  const texts: VText[] = []
  for (const t of p.texts as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.lines)) return null
    const lines: VLine[] = (t.lines as Record<string, unknown>[]).slice(0, 6).map((l) => {
      const text = String(l?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const n = text.split(' ').filter(Boolean).length
      const gold = Array.isArray(l?.gold) ? [...new Set((l.gold as unknown[]).map(Number).filter((g) => Number.isInteger(g) && g >= 0 && g < n))] : []
      const style = STYLES.has(String(l?.style)) ? String(l.style) : 'sub'
      const line: VLine = { text, style, gold }
      if (l?.maxW != null) line.maxW = int(l.maxW, 300, 900, 900)
      if (FONTS.has(String(l?.font))) line.font = String(l.font)
      return line
    }).filter((l) => l.text)
    if (!lines.length) continue
    const from = int(t.from, 0, last, 0)
    const x: VText = {
      id: String(t.id ?? '').replace(/[^\w-]/g, '').slice(0, 40) || `t${texts.length}`,
      from, to: int(t.to, from, last, from),
      y: int(t.y, 250, VH - 340 - 120, 820),
      scrim: num(t.scrim, 0, 0.8, 0.28),
      lines,
    }
    // субтитр голосу: секунди в межах відео
    if (Array.isArray(t.sec) && t.sec.length === 2) {
      const a = num(t.sec[0], 0, Math.max(0, dur - 0.2), 0)
      x.sec = [a, num(t.sec[1], a + 0.2, dur, dur)]
    }
    texts.push(x)
  }
  return {
    texts,
    wm: cleanWm(p.wm),
    cover: Math.round(num(p.cover, 0, Math.max(0, dur - 0.1), 0) * 10) / 10,
  }
}

// Знак з апки — лише відомі вид / місце / колір (план відео і обкладинка)
function cleanWm(raw: unknown): Plan['wm'] {
  const w = (raw ?? {}) as Record<string, unknown>
  return {
    kind: WM_KINDS.has(String(w.kind)) ? String(w.kind) : 'wm2',
    pos: WM_POS.has(String(w.pos)) ? String(w.pos) : 'br',
    color: w.color === 'gold' ? 'gold' : 'white',
  }
}

const FORMAT: Record<string, string> = { stories: 'Сторіз', reel: 'Рілс' }

// Підпис — як у final_worker.py (перша відправка)
const caption = (d: { name: string; format: string; place: string; dur: number | string }) =>
  `🎬 «${d.name}» — готове відео\n${FORMAT[d.format] ?? 'Відео'} · ${d.place} · ${Math.round(Number(d.dur))} с\n\n`
  + 'Збережи в галерею й виклади. Змінити текст — в апці, нове відео прийде сюди.'

// «Надіслати ще раз»: готовий фінал у чат того, хто натиснув. Є file_id з першої відправки — без повторного завантаження
export async function resendFinal(id: string, chatId: number): Promise<{ sent_at: string } | 'not_found' | 'not_ready'> {
  const r = await db().from('video_drafts').select('name, format, place, dur, final_path, cover_path, tg_file_id').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return 'not_found'
  const d = r.data as { name: string; format: string; place: string; dur: number; final_path: string | null; cover_path: string | null; tg_file_id: string | null }
  if (!d.final_path) return 'not_ready'
  const f = new FormData()
  f.append('chat_id', String(chatId))
  f.append('caption', caption(d))
  f.append('supports_streaming', 'true')
  let fileId = d.tg_file_id
  if (fileId) f.append('video', fileId)
  else {
    const [v, c] = await Promise.all([
      db().storage.from(BUCKET).download(d.final_path),
      d.cover_path ? db().storage.from(BUCKET).download(d.cover_path) : Promise.resolve(null),
    ])
    if (v.error) throw v.error
    f.append('video', v.data, 'final.mp4')
    f.append('width', '1080')
    f.append('height', '1920')
    f.append('duration', String(Math.round(Number(d.dur))))
    if (c?.data) { f.append('cover', 'attach://cv'); f.append('cv', c.data, 'cover.jpg') }
  }
  const m = await tgCall<{ video?: { file_id: string } }>('sendVideo', f)
  fileId = m.video?.file_id ?? fileId
  const sent_at = new Date().toISOString()
  // updated_at не чіпаємо: відправка — не правка (інакше відкритий редактор отримав би 409)
  await db().from('video_drafts').update({ tg_file_id: fileId, sent_at, sent_to: chatId }).eq('id', id).eq('final_path', d.final_path)
  return { sent_at }
}

// ───────────── Обкладинка (SQL 025, сет 2): прев'ю й файл малює Vercel тим самим satori, що воркер — миттєво, без воркера ─────────────

const COVER_TEXT = new Set(['hook', 'title', 'word'])
const KICKER_MAX = 40
const TITLE_MAX = 80
const PREVIEW_W = 540
const MEDIA_BUCKET = 'post-media'   // фото з бази (server/media.ts)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,40}$/
const COVER_COLS = 'name, format, place, plan, dur, status, poster_path, cover_spec, cover_cands, final_path, cover_path, remount, published_at, updated_at'
type CoverRow = Pick<DraftRow, 'name' | 'format' | 'place' | 'plan' | 'dur' | 'status' | 'poster_path' | 'cover_spec' | 'cover_cands' | 'final_path' | 'cover_path' | 'remount' | 'published_at' | 'updated_at'>

// Фон — лише чисті кадри воркера (Vercel кадр з відео не витягне). Чернетка без них (до SQL 025 / воркер ще не пройшов) —
// постер: він теж чистий кадр clean.mp4 на plan.cover
function coverCands(d: Pick<DraftRow, 'cover_cands' | 'poster_path' | 'plan'>): CoverCand[] {
  const c = (d.cover_cands ?? []).filter((x) => x?.path && Number.isFinite(Number(x.t)))
  if (c.length) return c.map((x) => ({ path: x.path, t: Number(x.t) }))
  return d.poster_path ? [{ path: d.poster_path, t: Number(d.plan?.cover ?? 0) }] : []
}
// Найближчий за часом кандидат: після перемонтажу bg.t іде за своїм кадром і може не збігтися з жодним
const nearest = (cands: CoverCand[], t: number) => cands.reduce<CoverCand | null>((b, c) => (!b || Math.abs(c.t - t) < Math.abs(b.t - t) ? c : b), null)

// Як default_spec у montage-test/cover.py (без AI-заголовка — він у воркері; в апці — «✨ Варіанти»): хук плану, його мітка або місце, знак плану
function defaultCover(d: Pick<DraftRow, 'plan' | 'name' | 'place' | 'cover_cands' | 'poster_path'>): CoverSpec {
  let title = '', kicker = ''
  for (const t of d.plan?.texts ?? []) {
    const head = t.sec ? undefined : t.lines.find((l) => COVER_TEXT.has(l.style))
    if (!head) continue
    const gold = new Set(head.gold)
    title = head.text.split(/\s+/).filter(Boolean).map((w, i) => (gold.has(i) ? `*${w}*` : w)).join(' ')
    kicker = t.lines.find((l) => l.style === 'label')?.text ?? ''
    break
  }
  return {
    bg: { kind: 'frame', t: coverCands(d)[0]?.t ?? Number(d.plan?.cover ?? 0) },
    kicker: kicker || d.place || '', title: title || d.name || '', y: COVER_Y,
    wm: d.plan?.wm ?? { kind: 'wm2', pos: 'br', color: 'white' },
  }
}

// Спека з апки → чиста: фон — найближчий кандидат або фото з бази (номер media), тексти обрізані, y у безпечній зоні,
// знак — відомі значення. null — не схоже на спеку. Чи є таке фото в базі — перевіряє coverBg
function cleanCover(raw: unknown, cands: CoverCand[]): CoverSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const rb = (s.bg && typeof s.bg === 'object' ? s.bg : {}) as Record<string, unknown>
  let bg: CoverBg
  if (rb.kind === 'media') {
    const mid = String(rb.media_id ?? '')
    if (!MEDIA_ID.test(mid)) return null
    bg = { kind: 'media', media_id: mid }
  } else {
    const c = nearest(cands, num(rb.t, 0, 3600, 0))
    if (!c) return null
    bg = { kind: 'frame', t: c.t }
  }
  const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  return {
    bg,
    kicker: txt(s.kicker, KICKER_MAX),
    // золото — *слово*; «слова» з самих зірочок прибираємо, інакше рендер зсуне номери золотих слів
    title: txt(s.title, TITLE_MAX).split(' ').filter((w) => w.replace(/\*/g, '')).join(' '),
    y: int(s.y, COVER_Y_MIN, COVER_Y_MAX, COVER_Y),
    wm: cleanWm(s.wm),
  }
}

// Фони кешуємо в теплому інстансі: Іра перебирає фон і текст — щоб не качати той самий JPEG на кожне прев'ю
const BG_TTL_MS = 10 * 60_000
const bgCache = new Map<string, { at: number; buf: Buffer }>()
async function bgFile(bucket: string, path: string) {
  const key = `${bucket}/${path}`
  const hit = bgCache.get(key)
  if (hit && Date.now() - hit.at < BG_TTL_MS) return hit.buf
  const r = await db().storage.from(bucket).download(path)
  if (r.error) throw r.error
  const buf = Buffer.from(await r.data.arrayBuffer())
  if (bgCache.size >= 12) bgCache.delete(bgCache.keys().next().value as string)
  bgCache.set(key, { at: Date.now(), buf })
  return buf
}

// Файл фону: кадр-кандидат (bucket video) або фото з бази (bucket post-media). null — фото вже нема в базі / кадрів ще нема
async function coverBg(d: CoverRow, bg: CoverBg): Promise<Buffer | null> {
  if (bg.kind === 'media') {
    const m = await db().from('media').select('storage_path').eq('media_id', bg.media_id).maybeSingle()
    if (m.error) throw m.error
    const path = (m.data as { storage_path?: string | null } | null)?.storage_path
    return path ? bgFile(MEDIA_BUCKET, path) : null
  }
  const c = nearest(coverCands(d), bg.t)
  return c ? bgFile(BUCKET, c.path) : null
}
const NO_MEDIA = 'Цього фото вже нема в базі — обери інше.'

async function coverRow(id: string) {
  const r = await db().from('video_drafts').select(COVER_COLS).eq('id', id).maybeSingle()
  if (r.error) throw r.error
  return r.data as CoverRow | null
}

// Готове відео вже є → cover.jpg поруч з ним теж новий: його бот шле в слот (server/video_publish.ts) і «Надіслати ще раз»
async function uploadCover(d: CoverRow, buf: Buffer) {
  if (!d.final_path) return
  const path = d.cover_path ?? d.final_path.replace(/[^/]+$/, 'cover.jpg')
  const u = await db().storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true })
  if (u.error) throw u.error
}

// Прев'ю 540×960 — той самий layout, що файл у чаті (малюємо 1080×1920 і зменшуємо)
export async function previewCover(id: string, raw: unknown) {
  const d = await coverRow(id)
  if (!d) return { code: 404, error: 'not found' }
  const spec = cleanCover(raw, coverCands(d))
  if (!spec) return { code: 400, error: 'bad cover' }
  const bg = await coverBg(d, spec.bg)
  if (!bg) return { code: 400, error: spec.bg.kind === 'media' ? NO_MEDIA : 'Немає кадру для обкладинки' }
  const buf = await coverJpeg(bg, spec, PREVIEW_W)
  return { code: 200, jpg: `data:image/jpeg;base64,${buf.toString('base64')}`, bg: spec.bg }
}

// Зберегти обкладинку: затвердження й готове відео НЕ скидаємо. Відео вже змонтоване — перемальовуємо cover.jpg тут же.
// Затверджено, а воркер ще монтує — рухаємо updated_at: його запис фіналу не пройде (план «змінився»), і він змонтує ще раз уже з новою обкладинкою
export async function saveCover(id: string, raw: unknown) {
  const d = await coverRow(id)
  if (!d) return { code: 404, error: 'not found' }
  if (d.published_at) return { code: 409, error: PUBLISHED_ERR }
  if (d.remount?.state === 'queued' || d.remount?.state === 'running') return { code: 409, error: 'Перемонтовую кадри — зачекай хвилинку, потім зміниш обкладинку.' }
  const spec = cleanCover(raw, coverCands(d))
  if (!spec) return { code: 400, error: 'bad cover' }
  const bg = await coverBg(d, spec.bg)
  if (!bg) return { code: 400, error: spec.bg.kind === 'media' ? NO_MEDIA : 'Немає кадру для обкладинки' }
  const rendering = d.status === 'approved' && !d.final_path
  const row: Record<string, unknown> = { cover_spec: spec }
  if (rendering) row.updated_at = new Date().toISOString()
  const r = await db().from('video_drafts').update(row).eq('id', id).is('published_at', null).select('updated_at, final_path')
  if (r.error) throw r.error
  if (!r.data?.length) return { code: 409, error: PUBLISHED_ERR }
  const cur = r.data[0] as { updated_at: string; final_path: string | null }
  if (cur.final_path) await uploadCover({ ...d, final_path: cur.final_path }, await coverJpeg(bg, spec))
  return { code: 200, cover_spec: spec, updated_at: cur.updated_at, file: Boolean(cur.final_path) }
}

// «Надіслати обкладинку ще раз»: свіжий рендер збереженої спеки файлом (Instagram просить обкладинку окремо, без стиснення) у чат того, хто натиснув
export async function sendCover(id: string, chatId: number) {
  const d = await coverRow(id)
  if (!d) return { code: 404, error: 'not found' }
  const spec = cleanCover(d.cover_spec ? { ...defaultCover(d), ...d.cover_spec } : defaultCover(d), coverCands(d))
  if (!spec) return { code: 409, error: 'Кадрів для обкладинки ще нема — зачекай, поки відео змонтується.' }
  const bg = await coverBg(d, spec.bg)
  if (!bg) return { code: 409, error: spec.bg.kind === 'media' ? NO_MEDIA : 'Кадрів для обкладинки ще нема — зачекай, поки відео змонтується.' }
  const buf = await coverJpeg(bg, spec)
  await uploadCover(d, buf)
  const f = new FormData()
  f.append('chat_id', String(chatId))
  f.append('caption', `🖼 Обкладинка «${d.name}» · ${FORMAT[d.format] ?? 'відео'}\n\nЗбережи й постав обкладинкою в Instagram.`)
  f.append('document', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), 'cover.jpg')
  await tgCall('sendDocument', f)
  return { code: 200, sent_at: new Date().toISOString() }
}

// ───────────── Обкладинка, сет 3: фон — фото з бази · AI-варіанти заголовка ─────────────

const HERE_MAX = 60      // фото цього місця
const OTHER_MAX = 24     // решта бази — після них
// Місце відео пишемо українською («Мальдіви», «Англія · Касл-Кум»), а в базі країна — англійською (hotels.country, media.destination).
// У відео hotel_id майже завжди порожній — тому «фото цього місця» шукаємо ще й за країною
const PLACE_COUNTRY: [RegExp, string][] = [
  [/мальдів/i, 'maldives'], [/греці|пелопон|наварин|кріт/i, 'greece'], [/сейшел/i, 'seychelles'],
  [/полінез|бора[\s-]?бора|таїт/i, 'french polynesia'], [/коста[\s-]?рік/i, 'costa rica'],
]
type MediaRow = { media_id: string; hotel_id: string | null; destination: string | null; width: number | null; height: number | null; usage_count: number | null; storage_path: string }

// «Фото з бази» для фону: спершу цього готелю / країни, у них — вертикальні (9:16 без обрізки), далі менш викладені й новіші; потім решта бази.
// Обране зараз фото — завжди в списку. here — фото цього місця, vertical — не обріжеться по боках
export async function coverMedia(id: string) {
  const r = await db().from('video_drafts').select('place, hotel_id, cover_spec').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return { code: 404, error: 'not found' }
  const d = r.data as { place: string | null; hotel_id: string | null; cover_spec: CoverSpec | null }
  const [h, m] = await Promise.all([
    db().from('hotels').select('hotel_id, name, country'),
    db().from('media').select('media_id, hotel_id, destination, width, height, usage_count, storage_path')
      .not('storage_path', 'is', null).or('type.is.null,type.eq.photo').limit(1000),
  ])
  if (h.error) throw h.error
  if (m.error) throw m.error
  const lc = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()
  const place = lc(d.place)
  const countries = new Set(PLACE_COUNTRY.filter(([re]) => re.test(place)).map(([, c]) => c))
  const hotels = new Set(((h.data ?? []) as { hotel_id: string; name: string | null; country: string | null }[])
    .filter((x) => x.hotel_id === d.hotel_id || countries.has(lc(x.country)) || (place && lc(x.name) && place.includes(lc(x.name))))
    .map((x) => x.hotel_id))
  const rows = ((m.data ?? []) as MediaRow[]).map((x) => ({
    ...x,
    here: Boolean((x.hotel_id && hotels.has(x.hotel_id)) || countries.has(lc(x.destination))),
    vertical: Boolean(x.width && x.height && x.height > x.width * 1.05),
  }))
  rows.sort((a, b) => Number(b.here) - Number(a.here) || Number(b.vertical) - Number(a.vertical)
    || (a.usage_count ?? 0) - (b.usage_count ?? 0) || b.media_id.localeCompare(a.media_id, 'en', { numeric: true }))
  const chosen = d.cover_spec?.bg?.kind === 'media' ? d.cover_spec.bg.media_id : null
  const here = rows.filter((x) => x.here).slice(0, HERE_MAX)
  // свого місця в базі нема (Англія, Альпи) — тоді вся база, вертикальні першими
  const list = [...here, ...rows.filter((x) => !x.here).slice(0, here.length ? OTHER_MAX : HERE_MAX)]
  const cur = chosen && !list.some((x) => x.media_id === chosen) ? rows.find((x) => x.media_id === chosen) : undefined
  if (cur) list.unshift(cur)
  const signed = list.length ? await db().storage.from(MEDIA_BUCKET).createSignedUrls(list.map((x) => x.storage_path), TTL_SEC) : { data: [], error: null }
  if (signed.error) throw signed.error
  const urls = new Map((signed.data ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path as string, s.signedUrl as string]))
  return {
    code: 200,
    items: list.flatMap((x) => (urls.has(x.storage_path) ? [{ media_id: x.media_id, url: urls.get(x.storage_path) as string, here: x.here, vertical: x.vertical }] : [])),
  }
}

const TITLES_MAX = 4
// Варіант від агента → «слова з *золотим* словом»: 2–7 слів (просимо 2–6, одне зайве — не привід викидати), без крапки й лапок;
// золото — перший *позначений* шматок, не більше 2 слів, кожне слово в зірочках окремо (як fmtTitle в апці). Не підходить — ''
export function cleanTitle(x: unknown): string {
  const raw = String((x && typeof x === 'object' ? (x as { title?: unknown }).title : x) ?? '')
    .replace(/\s+/g, ' ').trim().replace(/^["'«“„]+|["'»”]+$/g, '').replace(/[.。]+$/, '').trim()
  const m = /\*([^*]+)\*/.exec(raw)
  const gold = m ? m[1].trim().split(' ').filter(Boolean) : []
  const ws = raw.replace(/\*/g, '').split(' ').filter(Boolean)
  if (ws.length < 2 || ws.length > 7 || ws.join(' ').length > TITLE_MAX) return ''
  let at = -1
  if (gold.length && gold.length <= 2) {
    for (let i = 0; i + gold.length <= ws.length && at < 0; i++) if (gold.every((g, k) => ws[i + k] === g)) at = i
  }
  return ws.map((w, i) => (at >= 0 && i >= at && i < at + gold.length ? `*${w}*` : w)).join(' ')
}

// «✨ Варіанти»: 3–4 короткі заголовки обкладинки від агента (n8n WF «Video Cover Titles», тон PRMPT-011 + правила Іри).
// spec — те, що зараз у полях (може бути не збережене): поточний заголовок агент не повторює. Нічого не зберігаємо — Іра тапає варіант
export async function coverTitles(id: string, raw: unknown) {
  const r = await db().from('video_drafts').select('name, format, platform, place, hotel_id, plan_id, plan, caption, published_at').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return { code: 404, error: 'not found' }
  const d = r.data as { name: string; format: string; platform: string; place: string | null; hotel_id: string | null; plan_id: string | null; plan: Plan | null; caption: string | null; published_at: string | null }
  if (d.published_at) return { code: 409, error: PUBLISHED_ERR }
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cur = String(s.title ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  const texts = d.plan?.texts ?? []
  const [rules, hotel] = await Promise.all([
    iraRules(d.platform, d.hotel_id, d.plan_id),
    d.hotel_id ? db().from('hotels').select('name').eq('hotel_id', d.hotel_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  const j = await n8nJson('travellab-video-cover-titles', {
    name: d.name, format: d.format, platform: d.platform, place: d.place, hotel: (hotel.data as { name?: string } | null)?.name ?? null,
    kicker: String(s.kicker ?? '').replace(/\s+/g, ' ').trim().slice(0, KICKER_MAX), title: cur,
    screen: texts.filter((t) => !t.sec).flatMap((t) => t.lines.map((l) => l.text)).join(' / '),
    voice: texts.filter((t) => t.sec).flatMap((t) => t.lines.map((l) => l.text)).join(' ').slice(0, 1200),
    caption: (d.caption ?? '').slice(0, 800), rules,
  }, 40000)
  const seen = new Set([cur.toLowerCase()])
  const titles: string[] = []
  for (const x of Array.isArray(j?.titles) ? j.titles : []) {
    const t = cleanTitle(x)
    const k = t.replace(/\*/g, '').toLowerCase()
    if (!t || seen.has(k)) continue
    seen.add(k)
    titles.push(t)
    if (titles.length >= TITLES_MAX) break
  }
  if (!titles.length) return { code: 502, error: 'Агент зараз не відповів — спробуй ще раз за хвилинку.' }
  return { code: 200, titles }
}

// «✨ Варіанти» в редакторі тексту на фото поста (сет 5): той самий WF «Video Cover Titles», формат 'photo' —
// агенту йде текст поста й поточний напис; лише підказки, нічого не зберігаємо (Іра тапає варіант → він стає в поле)
export async function photoTitles(planId: string, raw: unknown) {
  const p = await db().from('content_plan').select('platform, hotel_id, current_version_id, published_at').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data?.current_version_id) return { code: 404, error: 'not found' }
  const d = p.data as { platform: string; hotel_id: string | null; current_version_id: string; published_at: string | null }
  if (d.published_at) return { code: 409, error: 'Пост уже викладено.' }
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cur = String(s.title ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  const [v, rules, hotel] = await Promise.all([
    db().from('post_versions').select('text, key_idea').eq('id', d.current_version_id).maybeSingle(),
    iraRules(d.platform, d.hotel_id, planId),
    d.hotel_id ? db().from('hotels').select('name, country').eq('hotel_id', d.hotel_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  if (v.error) throw v.error
  const h = hotel.data as { name?: string; country?: string } | null
  const j = await n8nJson('travellab-video-cover-titles', {
    name: String((v.data as { key_idea?: string } | null)?.key_idea ?? ''), format: 'photo', platform: d.platform,
    place: h?.country ?? null, hotel: h?.name ?? null,
    kicker: String(s.kicker ?? '').replace(/\s+/g, ' ').trim().slice(0, KICKER_MAX), title: cur, screen: cur, voice: '',
    caption: String((v.data as { text?: string } | null)?.text ?? '').replace(/\*\*/g, '').slice(0, 800), rules,
  }, 40000)
  const seen = new Set([cur.toLowerCase()])
  const titles: string[] = []
  for (const x of Array.isArray(j?.titles) ? j.titles : []) {
    const t = cleanTitle(x)
    const k = t.replace(/\*/g, '').toLowerCase()
    if (!t || seen.has(k)) continue
    seen.add(k)
    titles.push(t)
    if (titles.length >= TITLES_MAX) break
  }
  if (!titles.length) return { code: 502, error: 'Агент зараз не відповів — спробуй ще раз за хвилинку.' }
  return { code: 200, titles }
}

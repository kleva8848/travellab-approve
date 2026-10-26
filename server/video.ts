import { db, getSettings } from './http.js'
import { tgCall } from './publish.js'
import { videoMode } from './publish_plan.js'
import { kyivNow } from './schedule.js'

// Сторіз / рілс: чернетки з таблиці video_drafts (SQL 018). Файли — у приватному bucket `video` (signed URL на 2 год).
// План шарів (texts / wm / cover) — той самий формат, що src/lib/video.ts (VideoDraft без файлів і статусу).

const BUCKET = 'video'
const TTL_SEC = 2 * 60 * 60
const VH = 1920

const STYLES = new Set(['hook', 'title', 'word', 'num', 'sub', 'label'])
const WM_KINDS = new Set(['wm2', 'wm1', 'wm3', 'off'])
const WM_POS = new Set(['br', 'tr', 'bl', 'tl'])

type ShotRow = { t0: number; t1: number; label: string; file?: string; thumb_path: string }
type DraftRow = {
  id: string; name: string; format: string; platform: string; place: string; hotel_id: string | null; dur: number | string
  web_path: string; poster_path: string; shots: ShotRow[]; plan: Plan; status: string; scheduled_for: string | null; updated_at: string
  final_path: string | null; cover_path: string | null; rendered_at: string | null; render_error: string | null; sent_at: string | null
  remount: Remount | null
  montage: Montage | null
  // публікація (сет 7, SQL 022, server/video_publish.ts)
  caption: string | null; nomusic_path: string | null; delivered_at: string | null; published_at: string | null
  published_ref: { via?: string; posted_via?: string } | null
}
// Звук (сет 6, montage-test/music.py): трек Mixkit + точка старту; голос Іри з бота (file_id, тривалість після очистки)
type Montage = { music?: { title: string; artist: string; mood: string } | null; voice?: { dur: number } | null }
// Заявка на перемонтаж кадрів (SQL 020) — виконує montage-test/remount_worker.py
type Remount = { kind: string; shot?: number; order?: number[]; state: 'queued' | 'running' | 'done' | 'error'; at: string; by: number; error?: string; note?: string[] }
type VLine = { text: string; style: string; gold: number[]; maxW?: number }
type VText = { id: string; from: number; to: number; y: number; scrim: number; lines: VLine[]; sec?: [number, number] }
export type Plan = { texts: VText[]; wm: { kind: string; pos: string; color: string }; cover: number }

const COLS = 'id, name, format, platform, place, hotel_id, dur, web_path, poster_path, shots, plan, status, scheduled_for, updated_at, final_path, cover_path, rendered_at, render_error, sent_at, remount, montage, caption, nomusic_path, delivered_at, published_at, published_ref'

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
    shots: (d.shots ?? []).map((s) => ({ t0: s.t0, t1: s.t1, label: s.label, thumb: urls.get(s.thumb_path) ?? '' })),
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
  const [urls, voice_link, channel] = await Promise.all([sign([d.web_path, d.poster_path, ...(d.shots ?? []).map((s) => s.thumb_path)]), voiceLink(d.id), channelOn()])
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
  if (b.kind === 'remove' || b.kind === 'replace') {
    const shot = Number(b.shot)
    if (!Number.isInteger(shot) || shot < 0 || shot >= meta.n) return { code: 400, error: 'bad shot' }
    if (b.kind === 'remove' && meta.n < 2) return { code: 400, error: 'Це єдиний кадр — прибрати не можна.' }
    job.shot = shot
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
  const w = (p.wm ?? {}) as Record<string, unknown>
  return {
    texts,
    wm: {
      kind: WM_KINDS.has(String(w.kind)) ? String(w.kind) : 'wm2',
      pos: WM_POS.has(String(w.pos)) ? String(w.pos) : 'br',
      color: w.color === 'gold' ? 'gold' : 'white',
    },
    cover: Math.round(num(p.cover, 0, Math.max(0, dur - 0.1), 0) * 10) / 10,
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

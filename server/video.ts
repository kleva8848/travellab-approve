import { db } from './http.js'
import { tgCall } from './publish.js'
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
}
// Заявка на перемонтаж кадрів (SQL 020) — виконує montage-test/remount_worker.py
type Remount = { kind: string; shot?: number; order?: number[]; state: 'queued' | 'running' | 'done' | 'error'; at: string; by: number; error?: string; note?: string[] }
type VLine = { text: string; style: string; gold: number[]; maxW?: number }
type VText = { id: string; from: number; to: number; y: number; scrim: number; lines: VLine[] }
export type Plan = { texts: VText[]; wm: { kind: string; pos: string; color: string }; cover: number }

const COLS = 'id, name, format, platform, place, hotel_id, dur, web_path, poster_path, shots, plan, status, scheduled_for, updated_at, final_path, cover_path, rendered_at, render_error, sent_at, remount'

// Фінал (SQL 019, montage-test/final_worker.py) застарів після будь-якої правки / зміни статусу → воркер рендерить заново
export const FINAL_RESET = { final_path: null, cover_path: null, rendered_at: null, render_error: null, tg_file_id: null, sent_at: null, sent_to: null }

async function sign(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  if (!unique.length) return new Map()
  const r = await db().storage.from(BUCKET).createSignedUrls(unique, TTL_SEC)
  if (r.error) throw r.error
  return new Map((r.data ?? []).filter((s) => s.path && s.signedUrl).map((s) => [s.path as string, s.signedUrl as string]))
}

// Рядок → VideoDraft для апки (файли — signed URL)
function view(d: DraftRow, urls: Map<string, string>) {
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
  }
}

// Список на «Сьогодні»: усе, крім пропущених; мініатюри кадрів не підписуємо — там лише постер
export async function listVideos() {
  const r = await db().from('video_drafts').select(COLS).neq('status', 'skipped').order('created_at', { ascending: false }).limit(30)
  if (r.error) throw r.error
  const rows = (r.data ?? []) as DraftRow[]
  const urls = await sign(rows.map((d) => d.poster_path))
  return rows.map((d) => {
    const v = view(d, urls)
    return { id: v.id, name: v.name, format: v.format, platform: v.platform, place: v.place, dur: v.dur, poster: v.poster, status: v.status, scheduled_for: v.scheduled_for, ready: Boolean(v.final), remounting: v.remount?.state === 'queued' || v.remount?.state === 'running' }
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
  const urls = await sign([d.web_path, d.poster_path, ...(d.shots ?? []).map((s) => s.thumb_path)])
  return view(d, urls)
}

export async function draftMeta(id: string): Promise<{ n: number; dur: number; remounting: boolean } | null> {
  const r = await db().from('video_drafts').select('shots, dur, remount').eq('id', id).maybeSingle()
  if (r.error) throw r.error
  if (!r.data) return null
  const state = (r.data.remount as Remount | null)?.state
  return { n: ((r.data.shots ?? []) as unknown[]).length, dur: Number(r.data.dur), remounting: state === 'queued' || state === 'running' }
}

// ───────────── Перемонтаж кадрів (SQL 020) ─────────────

const IDLE = 'remount.is.null,remount->>state.in.(done,error)'

// Заявка з апки → у чергу воркера. Нове відео скидає затвердження й готовий фінал; тексти воркер переназначить сам.
// Рядок мав не змінитись з моменту, коли Іра відкрила відео (expected_updated_at), і не мати заявки в роботі.
export async function requestRemount(id: string, b: Record<string, unknown>, userId: number) {
  const meta = await draftMeta(id)
  if (!meta) return { code: 404, error: 'not found' }
  if (meta.remounting) return { code: 409, error: 'Уже перемонтовую — зачекай хвилинку.' }
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
  } else if (b.kind !== 'shorter') return { code: 400, error: 'bad kind' }

  const now = new Date().toISOString()
  let q = db().from('video_drafts').update({
    remount: { ...job, state: 'queued', at: now, by: userId },
    status: 'ready_for_review', approved_at: null, approved_by: null, ...FINAL_RESET, updated_at: now,
  }).eq('id', id).neq('status', 'skipped').or(IDLE)
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
  if (!Array.isArray(p.texts) || p.texts.length > 12) return null
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
    texts.push({
      id: String(t.id ?? '').replace(/[^\w-]/g, '').slice(0, 40) || `t${texts.length}`,
      from, to: int(t.to, from, last, from),
      y: int(t.y, 250, VH - 340 - 120, 820),
      scrim: num(t.scrim, 0, 0.8, 0.28),
      lines,
    })
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

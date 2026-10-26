// Чиста логіка автопублікації TG (без мережі/бази) — щоб перевіряти окремо.
// Що вже «настав час», як розкласти пост на повідомлення каналу з урахуванням лімітів Telegram.

export const TZ = 'Europe/Kyiv'
export const CAPTION_MAX = 1024
export const MESSAGE_MAX = 4096

// Зсув зони (мс) у момент ts
function tzOffset(ts: number, tz = TZ): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - Math.floor(ts / 1000) * 1000
}

// 'YYYY-MM-DD' + 'HH:MM[:SS]' за Києвом → мілісекунди UTC (або null)
export function kyivSlotMs(date: string | null, time: string | null): number | null {
  if (!date || !time) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})/.exec(time)
  if (!m || !t) return null
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2])
  let ms = guess - tzOffset(guess)
  ms = guess - tzOffset(ms) // уточнення біля переходу на літній/зимовий час
  return ms
}

export const slotKey = (date: string | null, time: string | null) => `${date ?? ''} ${String(time ?? '').slice(0, 5)}`

export type DueRow = {
  id: string
  platform: string
  review_status: string
  published_at: string | null
  scheduled_for: string | null
  slot_time: string | null
  current_version_id: string | null
  autopublish_slot?: string | null
}

// Пост пора викладати: TG, затверджений, не викладений, час слоту настав, але не давніше graceMin
// (старі пропущені пости автоматом не викладаємо — це рішення Іри). Слот, який уже пробували, — не повторюємо
export function isDue(p: DueRow, nowMs: number, graceMin: number): boolean {
  if (p.platform !== 'telegram' || p.review_status !== 'approved' || p.published_at || !p.current_version_id) return false
  const at = kyivSlotMs(p.scheduled_for, p.slot_time)
  if (at === null || at > nowMs || nowMs - at > graceMin * 60_000) return false
  return p.autopublish_slot !== slotKey(p.scheduled_for, p.slot_time)
}

// Довжина тексту, як її рахує Telegram (після розбору розмітки: без ** і HTML-тегів)
export const visibleLen = (text: string) => text.replace(/\*\*/g, '').length

// Довгий текст → шматки ≤ max видимих символів: по абзацах, далі по рядках, далі жорстко
export function splitText(text: string, max = MESSAGE_MAX): string[] {
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  const pieces = text.split(/(\n\n+)/)
  for (const piece of pieces) {
    if (visibleLen(cur + piece) <= max) {
      cur += piece
      continue
    }
    push()
    if (visibleLen(piece) <= max) {
      cur = piece
      continue
    }
    // Абзац довший за ліміт — по рядках, потім по символах
    for (const line of piece.split(/(\n)/)) {
      if (visibleLen(cur + line) <= max) {
        cur += line
        continue
      }
      push()
      let rest = line
      while (visibleLen(rest) > max) {
        out.push(rest.slice(0, max))
        rest = rest.slice(max)
      }
      cur = rest
    }
  }
  push()
  return out
}

// Як піде в канал: 'photos+caption' — фото/альбом з підписом; 'photos+text' — фото, потім текст окремо (підпис > 1024);
// 'text' — фото нема; 'photos' — тексту нема
export type Layout = { mode: 'photos+caption' | 'photos+text' | 'text' | 'photos' | 'empty'; caption: string | null; messages: string[] }
export function layoutPost(text: string, photos: number): Layout {
  const t = text.trim()
  if (!photos) return t ? { mode: 'text', caption: null, messages: splitText(t) } : { mode: 'empty', caption: null, messages: [] }
  if (!t) return { mode: 'photos', caption: null, messages: [] }
  if (visibleLen(t) <= CAPTION_MAX) return { mode: 'photos+caption', caption: t, messages: [] }
  return { mode: 'photos+text', caption: null, messages: splitText(t) }
}

// ───────────── Відео (SQL 022, server/video_publish.ts) ─────────────

// Instagram Іра викладає сама: якщо відео змонтувалось пізніше слоту (затвердила ввечері) — усе одно надішлемо в чат, але не давніше доби
export const CHAT_WINDOW_MIN = 24 * 60

export type VideoDueRow = {
  platform: string
  status: string
  scheduled_for: string | null
  final_path: string | null
  published_at: string | null
  delivered_at: string | null
  publish_slot: string | null
}

// Куди піде відео: 'channel' — TG-канал автоматично (платформа telegram, канал підключено); 'chat' — Ірі в чат «виклади зараз»
export const videoMode = (v: Pick<VideoDueRow, 'platform'>, channel: boolean): 'channel' | 'chat' =>
  v.platform === 'telegram' && channel ? 'channel' : 'chat'

// Відео пора відправити: затверджене, змонтоване, ще не вийшло й не надіслане, слот настав (канал — не давніше graceMin,
// чат — не давніше доби); слот, який уже пробували, не повторюємо (після помилки — вручну)
export function videoDue(v: VideoDueRow, nowMs: number, o: { channel: boolean; chatOn: boolean; graceMin: number }): 'channel' | 'chat' | null {
  if (v.status !== 'approved' || !v.final_path || v.published_at || v.delivered_at || !v.scheduled_for) return null
  const at = Date.parse(v.scheduled_for)
  if (!Number.isFinite(at) || at > nowMs || v.publish_slot === v.scheduled_for) return null
  const mode = videoMode(v, o.channel)
  if (mode === 'chat' && !o.chatOn) return null
  const win = mode === 'channel' ? o.graceMin : Math.max(o.graceMin, CHAT_WINDOW_MIN)
  return nowMs - at > win * 60_000 ? null : mode
}

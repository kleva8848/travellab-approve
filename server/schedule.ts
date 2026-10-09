import { db, getSettings } from './http.js'

// Дата й час публікації. Затверджений пост сам стає на найближчий вільний день своєї платформи (1 пост / платформа / день),
// час — за замовчуванням платформи (settings.slot_times перекриває). Іра міняє дату/час у календарі
const DEFAULT_TIMES: Record<string, string> = { telegram: '10:00', instagram: '19:00', threads: '13:00' }
const TZ = 'Europe/Kyiv'
const MAX_DAYS = 90

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// «Зараз» у Києві: { date: 'YYYY-MM-DD', time: 'HH:MM' }
function kyivNow() {
  const [date, time] = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date())
    .split(' ')
  return { date, time }
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function slotTime(platform: string): Promise<string> {
  const s = await getSettings(['slot_times'])
  const custom = (s.slot_times ?? {}) as Record<string, unknown>
  const t = typeof custom[platform] === 'string' ? (custom[platform] as string) : DEFAULT_TIMES[platform] ?? '12:00'
  return TIME_RE.test(t) ? t : '12:00'
}

// Ставить пост на дату, якщо її ще нема. Повертає { scheduled_for, slot_time } або null (пост уже з датою / не знайдено)
export async function scheduleIfNeeded(planId: string) {
  const p = await db().from('content_plan').select('platform, scheduled_for').eq('id', planId).maybeSingle()
  if (p.error) throw p.error
  if (!p.data || p.data.scheduled_for) return null
  const platform = String(p.data.platform)
  const time = await slotTime(platform)
  const now = kyivNow()
  const taken = await db()
    .from('content_plan')
    .select('scheduled_for')
    .eq('platform', platform)
    .in('review_status', ['approved', 'published'])
    .gte('scheduled_for', now.date)
  if (taken.error) throw taken.error
  const busy = new Set((taken.data ?? []).map((x) => String(x.scheduled_for)))
  // Сьогодні — лише якщо час слоту ще не минув
  let date = now.time < time ? now.date : addDays(now.date, 1)
  for (let i = 0; i < MAX_DAYS && busy.has(date); i++) date = addDays(date, 1)
  const r = await db()
    .from('content_plan')
    .update({ scheduled_for: date, slot_time: time, updated_at: new Date().toISOString() })
    .eq('id', planId)
    .is('scheduled_for', null)
    .select('scheduled_for, slot_time')
  if (r.error) throw r.error
  return r.data?.[0] ?? null
}

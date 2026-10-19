import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'
import { failSchema } from '../server/schema.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type AudienceRow = { id: string; code: string; name: string; who: string; match_words: string; active: boolean; sort_order: number }
type QuestionRow = { id: string; audience_id: string; question: string; with_hotel: boolean; active: boolean; sort_order: number }

// Дужки й крапка в назві ламають розбір note «Для кого: P1 Назва (хто)» (lib/audience.ts) — прибираємо
const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const cleanName = (s: unknown) => clean(s, 60).replace(/[().]/g, '').trim()
const cleanWho = (s: unknown) => clean(s, 300).replace(/[()]/g, ',')

// Той самий фокус, що поставить WF-018 у неділю: активні аудиторії по колу за ISO-тижнем наступного понеділка
function nextWeekNo(now = new Date()): number {
  const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const today = new Date(kyiv + 'T00:00:00Z')
  const dow = (today.getUTCDay() + 6) % 7
  const weekStart = new Date(today.getTime() + (dow === 0 ? 0 : 7 - dow) * 86400000)
  const thu = new Date(weekStart.getTime() + 3 * 86400000)
  return 1 + Math.floor((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000))
}

async function load() {
  const [a, q] = await Promise.all([
    db().from('audiences').select('id, code, name, who, match_words, active, sort_order').order('sort_order').order('code'),
    db().from('audience_questions').select('id, audience_id, question, with_hotel, active, sort_order').order('sort_order').order('created_at'),
  ])
  if (a.error) throw a.error
  if (q.error) throw q.error
  const qs = (q.data ?? []) as QuestionRow[]
  const audiences = ((a.data ?? []) as AudienceRow[]).map((x) => ({ ...x, questions: qs.filter((y) => y.audience_id === x.id) }))
  const on = audiences.filter((x) => x.active)
  const next = on.length ? on[nextWeekNo() % on.length].id : null
  return { audiences, next_focus_id: next }
}

// Вкладка «Аудиторії» (Іра + Влад): портрети й питання клієнтів, з яких WF-018 складає план тижня.
// GET → { audiences: [...questions], next_focus_id }
// POST { action: 'audience_save', id?, name, who, match_words? } | { action: 'audience_active', id, active }
//      { action: 'question_save', id?, audience_id, question, with_hotel } | { action: 'question_active', id, active }
// Видалення нема — лише вимкнути (історія тижнів посилається на code у note)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  try {
    if (req.method === 'GET') return void res.json(await load())
    if (req.method !== 'POST') return void res.status(405).json({ error: 'GET / POST only' })
    const b = (req.body ?? {}) as Record<string, unknown>
    const id = b.id == null || b.id === '' ? null : String(b.id)
    if (id && !UUID.test(id)) return void res.status(400).json({ error: 'bad id' })
    const now = new Date().toISOString()

    if (b.action === 'audience_save') {
      const name = cleanName(b.name)
      if (!name) return void res.status(400).json({ error: 'потрібна назва' })
      const row: Record<string, unknown> = { name, who: cleanWho(b.who), updated_at: now }
      // слова підбору готелів редагує лише адмін (Іра їх не бачить — не затираємо)
      if (user.is_admin && b.match_words !== undefined) row.match_words = clean(b.match_words, 300)
      if (id) {
        const r = await db().from('audiences').update(row).eq('id', id).select('id')
        if (r.error) throw r.error
        if (!r.data?.length) return void res.status(404).json({ error: 'not found' })
      } else {
        const all = await db().from('audiences').select('code, sort_order')
        if (all.error) throw all.error
        const rows = (all.data ?? []) as { code: string; sort_order: number }[]
        const n = Math.max(0, ...rows.map((x) => Number(/^P(\d+)$/.exec(x.code)?.[1] ?? 0))) + 1
        const order = Math.max(0, ...rows.map((x) => x.sort_order ?? 0)) + 1
        const r = await db().from('audiences').insert({ ...row, code: `P${n}`, sort_order: order })
        if (r.error) throw r.error
      }
    } else if (b.action === 'question_save') {
      const question = clean(b.question, 300)
      if (!question) return void res.status(400).json({ error: 'потрібне питання' })
      const row = { question, with_hotel: b.with_hotel !== false, updated_at: now }
      if (id) {
        const r = await db().from('audience_questions').update(row).eq('id', id).select('id')
        if (r.error) throw r.error
        if (!r.data?.length) return void res.status(404).json({ error: 'not found' })
      } else {
        const aud = String(b.audience_id ?? '')
        if (!UUID.test(aud)) return void res.status(400).json({ error: 'bad audience_id' })
        const last = await db().from('audience_questions').select('sort_order').eq('audience_id', aud).order('sort_order', { ascending: false }).limit(1)
        if (last.error) throw last.error
        const order = ((last.data?.[0] as { sort_order: number } | undefined)?.sort_order ?? 0) + 1
        const r = await db().from('audience_questions').insert({ ...row, audience_id: aud, sort_order: order })
        if (r.error) throw r.error
      }
    } else if (b.action === 'audience_active' || b.action === 'question_active') {
      if (!id) return void res.status(400).json({ error: 'bad id' })
      const table = b.action === 'audience_active' ? 'audiences' : 'audience_questions'
      // без жодної активної WF-018 повернувся б до портретів з коду — не даємо вимкнути останню
      if (table === 'audiences' && b.active !== true) {
        const on = await db().from('audiences').select('id').eq('active', true).neq('id', id).limit(1)
        if (on.error) throw on.error
        if (!on.data?.length) return void res.status(409).json({ error: 'Це остання активна аудиторія — спершу увімкни або додай іншу.' })
      }
      const r = await db().from(table).update({ active: b.active === true, updated_at: now }).eq('id', id).select('id')
      if (r.error) throw r.error
      if (!r.data?.length) return void res.status(404).json({ error: 'not found' })
    } else {
      return void res.status(400).json({ error: 'bad action' })
    }
    res.json(await load())
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

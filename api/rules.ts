import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLATFORM: Record<string, string> = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }
const PILLAR: Record<string, string> = { hotel_place: 'про готель', insider: 'інсайдер', tour_offer: 'офер туру', personal_take: 'думка', family: 'сімейний', unusual_hotels: 'незвичайні готелі', video: 'відео', template: 'шаблон' }

type RuleRow = { id: string; rule_text: string; scope: string; scope_value: string | null; status: string; created_at: string; source_comment_id: string | null }

// Правила з правок Іри (фаза 7) — лише для адмінів (ADMIN_TG_IDS): глобальні чекають ✅ Влада, решта діє одразу (можна вимкнути).
// GET → { pending, active }; POST { id, decision: 'approve' | 'reject' | 'disable' }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  if (!user.is_admin) return void res.status(403).json({ error: 'forbidden' })
  try {
    if (req.method === 'GET') {
      const r = await db().from('ira_rules').select('id, rule_text, scope, scope_value, status, created_at, source_comment_id').in('status', ['pending', 'active']).order('created_at', { ascending: false })
      if (r.error) return void res.json({ pending: [], active: [] })
      const rows = (r.data ?? []) as RuleRow[]
      const hotelIds = [...new Set(rows.filter((x) => x.scope === 'hotel' && x.scope_value).map((x) => x.scope_value as string))]
      const commentIds = [...new Set(rows.map((x) => x.source_comment_id).filter(Boolean))] as string[]
      const [h, c] = await Promise.all([
        hotelIds.length ? db().from('hotels').select('hotel_id, name').in('hotel_id', hotelIds) : Promise.resolve({ data: [], error: null }),
        commentIds.length ? db().from('review_comments').select('id, body').in('id', commentIds) : Promise.resolve({ data: [], error: null }),
      ])
      const hotels = new Map(((h.data ?? []) as { hotel_id: string; name: string }[]).map((x) => [x.hotel_id, x.name]))
      const bodies = new Map(((c.data ?? []) as { id: string; body: string }[]).map((x) => [x.id, x.body]))
      const where = (x: RuleRow) =>
        x.scope === 'hotel' ? hotels.get(x.scope_value ?? '') ?? x.scope_value ?? 'готель'
          : x.scope === 'platform' ? PLATFORM[x.scope_value ?? ''] ?? x.scope_value ?? ''
            : x.scope === 'pillar' ? `рубрика «${PILLAR[x.scope_value ?? ''] ?? x.scope_value}»`
              : 'усі пости'
      const view = (x: RuleRow) => ({
        id: x.id, rule_text: x.rule_text, scope: x.scope, where: where(x), created_at: x.created_at,
        source: x.source_comment_id ? (bodies.get(x.source_comment_id) ?? '').slice(0, 200) : null,
      })
      return void res.json({ pending: rows.filter((x) => x.status === 'pending').map(view), active: rows.filter((x) => x.status === 'active').map(view) })
    }
    if (req.method !== 'POST') return void res.status(405).json({ error: 'GET / POST only' })
    const b = (req.body ?? {}) as { id?: string; decision?: string }
    if (!b.id || !UUID.test(b.id)) return void res.status(400).json({ error: 'bad id' })
    const step: Record<string, { from: string; to: string }> = {
      approve: { from: 'pending', to: 'active' },
      reject: { from: 'pending', to: 'rejected' },
      disable: { from: 'active', to: 'rejected' },
    }
    const s = step[String(b.decision)]
    if (!s) return void res.status(400).json({ error: 'bad decision' })
    const r = await db().from('ira_rules')
      .update({ status: s.to, decided_at: new Date().toISOString(), decided_by: user.id })
      .eq('id', b.id).eq('status', s.from).select('id')
    if (r.error) throw r.error
    return r.data?.length ? void res.json({ ok: true }) : void res.status(409).json({ error: 'conflict' })
  } catch (e) {
    fail(res, e)
  }
}

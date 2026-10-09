import type { VercelRequest, VercelResponse } from '@vercel/node'
import { timingSafeEqual } from 'node:crypto'
import { fail } from '../server/http.js'
import { publishDue } from '../server/publish.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Автопублікація TG у канал. Кличе n8n (кожні 5 хв) з заголовком X-TL-Secret = N8N_WEBHOOK_SECRET.
// body: { dry_run?: boolean, plan_id?: uuid, chat_id?: тест — лише admin_chat_id, статус не міняє }
// dry_run → що виклало б зараз (без рендеру й відправки), працює і коли перемикач вимкнений
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return void res.status(405).json({ error: 'POST only' })
  const secret = process.env.N8N_WEBHOOK_SECRET ?? ''
  const got = String(req.headers['x-tl-secret'] ?? '')
  const a = Buffer.from(got)
  const b = Buffer.from(secret)
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return void res.status(401).json({ error: 'unauthorized' })

  const body = (req.body ?? {}) as { dry_run?: unknown; plan_id?: unknown; chat_id?: unknown }
  const planId = body.plan_id == null ? undefined : String(body.plan_id)
  if (planId && !UUID.test(planId)) return void res.status(400).json({ error: 'bad plan_id' })
  const chatOverride = body.chat_id == null || body.chat_id === '' ? undefined : String(body.chat_id)
  try {
    res.json(await publishDue({ dryRun: body.dry_run === true || body.dry_run === 'true', planId, chatOverride }))
  } catch (e) {
    fail(res, e)
  }
}

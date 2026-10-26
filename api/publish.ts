import type { VercelRequest, VercelResponse } from '@vercel/node'
import { timingSafeEqual } from 'node:crypto'
import { fail } from '../server/http.js'
import { publishDue } from '../server/publish.js'
import { publishVideos } from '../server/video_publish.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Автопублікація TG у канал. Кличе n8n (кожні 5 хв) з заголовком X-TL-Secret = N8N_WEBHOOK_SECRET.
// body: { dry_run?: boolean, plan_id?: uuid, chat_id?: тест — лише admin_chat_id, статус не міняє }
// dry_run → що виклало б зараз (без рендеру й відправки), працює і коли перемикач вимкнений
// Відео (сет 7, SQL 022, server/video_publish.ts) — у тому ж виклику, після постів: TG-канал авто / Ірі в чат для Instagram.
//   Тест одного відео: { video_id, chat_id: admin_chat_id | settings.tg_test_channel_id, as?: 'channel' | 'chat' } — статус не міняє.
// Відповідь: { ...пости, videos: {...} }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return void res.status(405).json({ error: 'POST only' })
  const secret = process.env.N8N_WEBHOOK_SECRET ?? ''
  const got = String(req.headers['x-tl-secret'] ?? '')
  const a = Buffer.from(got)
  const b = Buffer.from(secret)
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return void res.status(401).json({ error: 'unauthorized' })

  const body = (req.body ?? {}) as { dry_run?: unknown; plan_id?: unknown; chat_id?: unknown; video_id?: unknown; as?: unknown }
  const planId = body.plan_id == null ? undefined : String(body.plan_id)
  if (planId && !UUID.test(planId)) return void res.status(400).json({ error: 'bad plan_id' })
  const videoId = body.video_id == null ? undefined : String(body.video_id)
  if (videoId && !UUID.test(videoId)) return void res.status(400).json({ error: 'bad video_id' })
  const chatOverride = body.chat_id == null || body.chat_id === '' ? undefined : String(body.chat_id)
  const dryRun = body.dry_run === true || body.dry_run === 'true'
  const as = body.as === 'channel' || body.as === 'chat' ? body.as : undefined
  try {
    // конкретне відео — лише відео; конкретний пост — лише пости
    const posts = videoId ? null : await publishDue({ dryRun, planId, chatOverride })
    // відео не має валити пости: помилка (напр. ще нема SQL 022) — у відповіді, пости вже відпрацювали
    const videos = planId ? null : await publishVideos({ dryRun, videoId, chatOverride, as }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e) }))
    res.json({ ...(posts ?? { ok: true }), videos })
  } catch (e) {
    fail(res, e)
  }
}

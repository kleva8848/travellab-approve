import type { VercelRequest, VercelResponse } from '@vercel/node'

const NAMES = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALLOWED_TG_IDS', 'ADMIN_TG_IDS', 'N8N_WEBHOOK_SECRET']

const idList = (v: string | undefined) => {
  const parts = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return { count: parts.filter((p) => /^\d+$/.test(p)).length, invalid: parts.filter((p) => !/^\d+$/.test(p)).length }
}

// Діагностика: чи задані змінні, чи живий бот і чи є таблиця settings (без значень і без даних)
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const env = Object.fromEntries(NAMES.map((n) => [n, Boolean(process.env[n]?.trim())]))

  // settings: 200 = таблиця є; 404/42P01 = міграцію 001 ще не запущено
  let db: number | string = 'skipped'
  let settingsKeys: number | null = null
  let reviewSchema: boolean | null = null
  let readyForReview: number | null = null
  let ms = 0
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const t0 = Date.now()
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/settings?select=key`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
      db = r.status
      ms = Date.now() - t0
      if (r.ok) settingsKeys = ((await r.json()) as unknown[]).length
      // Фаза 2: чи запущено 002 (post_versions) і скільки постів чекає Іру після 003
      const q = await fetch(`${process.env.SUPABASE_URL}/rest/v1/content_plan?select=id&review_status=eq.ready_for_review`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
      reviewSchema = q.ok
      if (q.ok) readyForReview = ((await q.json()) as unknown[]).length
    } catch (e) {
      db = e instanceof Error ? e.message : 'error'
    }
  }

  // Чи правильний токен бота (інакше Telegram-вхід не пройде ні в кого)
  let bot: string | null = null
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
      const j = (await r.json()) as { ok: boolean; result?: { username: string } }
      bot = j.ok ? `@${j.result?.username}` : null
    } catch {
      bot = null
    }
  }

  res.json({
    env,
    allowed: idList(process.env.ALLOWED_TG_IDS),
    admins: idList(process.env.ADMIN_TG_IDS),
    bot,
    db_ok: db === 200,
    db,
    db_ms: ms,
    settings_keys: settingsKeys,
    review_schema: reviewSchema,
    ready_for_review: readyForReview,
    region: process.env.VERCEL_REGION ?? null,
  })
}

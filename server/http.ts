import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { adminIds, allowedIds, verifyInitData, type TgUser } from './auth.js'

let client: SupabaseClient | null = null

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
    client = createClient(url, key, { auth: { persistSession: false } })
  }
  return client
}

export type AppUser = TgUser & { is_admin: boolean }

// Повертає користувача або відповідає 401/403 і повертає null
export function requireUser(req: VercelRequest, res: VercelResponse): AppUser | null {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
    return null
  }
  const header = req.headers.authorization ?? ''
  const initData = header.startsWith('tma ') ? header.slice(4) : ''
  const user = initData ? verifyInitData(initData, token) : null
  if (!user) {
    res.status(401).json({ error: 'unauthorized' })
    return null
  }
  if (!allowedIds().has(user.id)) {
    res.status(403).json({ error: 'forbidden', tg_id: user.id })
    return null
  }
  return { ...user, is_admin: adminIds().has(user.id) }
}

export function fail(res: VercelResponse, e: unknown) {
  const message = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e)
  res.status(500).json({ error: message })
}

// Налаштування з таблиці settings (ID папок, chat_id, URL вебхуків) — жодних ID у коді, щоб перенос на акаунти Іри = лише нові значення
export async function getSettings(keys?: string[]): Promise<Record<string, unknown>> {
  let q = db().from('settings').select('key, value')
  if (keys) q = q.in('key', keys)
  const r = await q
  if (r.error) throw r.error
  return Object.fromEntries((r.data ?? []).map((x) => [x.key, x.value]))
}

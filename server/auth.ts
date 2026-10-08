import { createHmac, timingSafeEqual } from 'node:crypto'

export type TgUser = { id: number; first_name?: string; username?: string }

const MAX_AGE_SEC = 24 * 60 * 60

// Перевірка Telegram Mini App initData: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData: string, botToken: string, nowSec = Math.floor(Date.now() / 1000)): TgUser | null {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const authDate = Number(params.get('auth_date'))
  if (!authDate || nowSec - authDate > MAX_AGE_SEC) return null

  try {
    return JSON.parse(params.get('user') ?? 'null')
  } catch {
    return null
  }
}

export function allowedIds(): Set<number> {
  return new Set(
    (process.env.ALLOWED_TG_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  )
}

// Адміни (Влад): бачать службові екрани й схвалюють глобальні правила. Підмножина ALLOWED_TG_IDS
export function adminIds(): Set<number> {
  return new Set(
    (process.env.ADMIN_TG_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  )
}

import type { VercelResponse } from '@vercel/node'

// Міграцію 002 ще не запущено → 503 з кодом, щоб апка показала «ще налаштовуємо», а не помилку
export function failSchema(res: VercelResponse, e: unknown): boolean {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  const msg = typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : ''
  if (code === '42703' || code === '42P01' || code === 'PGRST205' || code === 'PGRST204' || /review_status|post_versions/.test(msg)) {
    res.status(503).json({ error: 'schema_pending' })
    return true
  }
  return false
}

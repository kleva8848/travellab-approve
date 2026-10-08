import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fail, requireUser } from '../server/http.js'
import { loadQueue } from '../server/review.js'
import { failSchema } from '../server/schema.js'

// Черга Іри: пости на перегляд + затверджені (для календаря)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  try {
    res.json({ items: await loadQueue() })
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

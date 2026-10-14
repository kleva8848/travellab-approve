import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fail, requireUser } from '../server/http.js'
import { loadQueue } from '../server/review.js'
import { failSchema } from '../server/schema.js'
import { storyInfo } from '../server/story.js'

// Черга Іри: пости на перегляд + затверджені (для календаря) + «🎙 Розповісти історію» (null — голос вимкнено)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  try {
    const [items, story] = await Promise.all([loadQueue(), storyInfo().catch(() => null)])
    res.json({ items, story })
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

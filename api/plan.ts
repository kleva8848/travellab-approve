import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fail, requireUser } from '../server/http.js'
import { loadWeekPlan } from '../server/review.js'
import { failSchema } from '../server/schema.js'

// Вкладка «План»: слоти тижня (?week=0 поточний, 1 наступний, -1 минулий)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  const week = Math.max(-4, Math.min(4, Math.trunc(Number(req.query.week ?? 0)) || 0))
  try {
    res.json(await loadWeekPlan(week))
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

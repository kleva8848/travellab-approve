import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireUser } from '../server/http.js'

export default function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (user) res.json({ user })
}

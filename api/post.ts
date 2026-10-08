import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fail, requireUser } from '../server/http.js'
import { loadPost } from '../server/review.js'
import { failSchema } from '../server/schema.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Один пост: план, усі версії, правки Іри
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  const id = String(req.query.id ?? '')
  if (!UUID.test(id)) return void res.status(400).json({ error: 'bad id' })
  try {
    const post = await loadPost(id)
    if (!post) return void res.status(404).json({ error: 'not found' })
    res.json(post)
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'
import { failSchema } from '../server/schema.js'
import { FINAL_RESET, PUBLISHED_ERR, ackRemount, cleanPlan, draftMeta, getVideo, listVideoGaps, listVideos, requestRemount, resendFinal, saveCaption } from '../server/video.js'
import { markPosted } from '../server/video_publish.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Сторіз / рілс на перегляд (SQL 018 video_drafts).
// GET → { items, gaps } (список для «Сьогодні»; gaps — слоти, де агенту бракує кадрів, SQL 021) · GET ?id= → { video } (редактор, файли — signed URL)
// POST { action: 'save', id, plan, expected_updated_at? } — правки тексту / знака / обкладинки
//      { action: 'approve', id, plan? } — затвердити (з планом — спершу зберегти) · 'unapprove' · 'skip' — не публікувати
//      { action: 'resend', id } — готове відео (SQL 019) ще раз у чат того, хто натиснув → { ok, sent_at }
//      { action: 'remount', id, kind: 'remove'|'replace'|'moment'|'reorder'|'shorter'|'music'|'novoice', shot?, start?, order?, mood?, expected_updated_at? } —
//        перемонтаж кадрів (SQL 020, воркер montage-test/remount_worker.py, 30–90 с); поки йде — save / approve → 409.
//        music — інший трек (сет 6), novoice — прибрати голос; голос (kind 'voice') кладе бот WF-055 сам, не апка
//      { action: 'remount_ok', id } — Іра прочитала підсумок перемонтажу (remount.note / error)
//      { action: 'caption', id, caption } — підпис до поста (SQL 022); готове відео не скидає → { ok, caption }
//      { action: 'posted', id } — «✅ Виклала» (Instagram / TG вручну) → { ok, published_at }; після цього правки → 409
// Відповідь POST → { ok, status, updated_at }. Фінальний mp4 з шарами збирає montage-test/final_worker.py (бере approved без final_path);
// save / approve / unapprove чистять final_* — після правки воркер збирає нове відео
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = requireUser(req, res)
  if (!user) return
  try {
    if (req.method === 'GET') {
      const id = String(req.query.id ?? '')
      if (!id) {
        const [items, gaps] = await Promise.all([listVideos(), listVideoGaps()])
        return void res.json({ items, gaps })
      }
      if (!UUID.test(id)) return void res.status(400).json({ error: 'bad id' })
      const video = await getVideo(id)
      if (!video) return void res.status(404).json({ error: 'not found' })
      return void res.json({ video })
    }
    if (req.method !== 'POST') return void res.status(405).json({ error: 'GET / POST only' })

    const b = (req.body ?? {}) as Record<string, unknown>
    const id = String(b.id ?? '')
    if (!UUID.test(id)) return void res.status(400).json({ error: 'bad id' })
    if (b.action === 'resend') {
      const r = await resendFinal(id, user.id)
      if (r === 'not_found') return void res.status(404).json({ error: 'not found' })
      if (r === 'not_ready') return void res.status(409).json({ error: 'Відео ще монтується — надішлю в чат, щойно буде готове.' })
      return void res.json({ ok: true, ...r })
    }
    if (b.action === 'remount') {
      const { code, ...r } = await requestRemount(id, b, user.id)
      return void res.status(code).json(code === 200 ? { ok: true, ...r } : r)
    }
    if (b.action === 'remount_ok') return void res.json({ ok: await ackRemount(id) })
    if (b.action === 'caption') {
      const r = await saveCaption(id, b.caption)
      if (!r) return void res.status(409).json({ error: PUBLISHED_ERR })
      return void res.json({ ok: true, ...r })
    }
    if (b.action === 'posted') {
      const r = await markPosted(id, user.id)
      if (r === 'not_found') return void res.status(404).json({ error: 'not found' })
      if (r === 'not_ready') return void res.status(409).json({ error: 'Відео ще не затверджене або не змонтоване.' })
      return void res.json({ ok: true, ...r })
    }
    const now = new Date().toISOString()
    const row: Record<string, unknown> = { updated_at: now }

    if (b.action === 'save' || b.action === 'approve' || b.action === 'unapprove' || b.action === 'skip') {
      const meta = await draftMeta(id)
      if (!meta) return void res.status(404).json({ error: 'not found' })
      if (meta.published) return void res.status(409).json({ error: PUBLISHED_ERR })
      // воркер перемонтовує кадри й сам переназначить тексти — правка зараз загубилась би
      if (meta.remounting && b.action !== 'skip') return void res.status(409).json({ error: 'Перемонтовую кадри — зачекай хвилинку, потім зміниш текст.' })
      if (b.action === 'save' || (b.action === 'approve' && b.plan !== undefined)) {
        const plan = cleanPlan(b.plan, meta.n, meta.dur)
        if (!plan) return void res.status(400).json({ error: 'bad plan' })
        row.plan = plan
      }
    }
    if (b.action !== 'skip') Object.assign(row, FINAL_RESET)
    if (b.action === 'approve') Object.assign(row, { status: 'approved', approved_at: now, approved_by: user.id })
    else if (b.action === 'unapprove') Object.assign(row, { status: 'ready_for_review', approved_at: null, approved_by: null })
    else if (b.action === 'skip') row.status = 'skipped'
    else if (b.action !== 'save') return void res.status(400).json({ error: 'bad action' })

    let q = db().from('video_drafts').update(row).eq('id', id)
    // Іра і Влад можуть правити одне відео — не затираємо чужі правки мовчки
    if (b.action === 'save' && b.expected_updated_at) q = q.eq('updated_at', String(b.expected_updated_at))
    const r = await q.select('status, updated_at')
    if (r.error) throw r.error
    if (!r.data?.length) {
      return void res.status(b.action === 'save' && b.expected_updated_at ? 409 : 404).json({
        error: b.action === 'save' && b.expected_updated_at ? 'Це відео щойно змінили з іншого телефона — відкрий його ще раз.' : 'not found',
      })
    }
    res.json({ ok: true, ...(r.data[0] as { status: string; updated_at: string }) })
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

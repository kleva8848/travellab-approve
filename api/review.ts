import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'
import { insertOwnMedia, isUploadPath, uploadExists, uploadUrl } from '../server/media.js'
import { notifyN8n } from '../server/review.js'
import { failSchema } from '../server/schema.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_COMMENT = 2000

type Body = {
  action?: 'approve' | 'comment' | 'restore' | 'unapprove' | 'swap_photo' | 'upload_url' | 'add_photo'
  id?: string
  expected_version_no?: number
  text?: string
  photo?: string
  chips_text?: string[]
  chips_photo?: string[]
  version_id?: string
  slide_idx?: number
  path?: string
  mode?: 'replace' | 'add'
  width?: number
  height?: number
}

// Дії Іри над постом. expected_version_no — захист від подвійного тапу і застарілого екрана (409 → апка перечитує пост)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return void res.status(405).json({ error: 'POST only' })
  const user = requireUser(req, res)
  if (!user) return
  const b = (req.body ?? {}) as Body
  if (!b.id || !UUID.test(b.id)) return void res.status(400).json({ error: 'bad id' })
  const expected = Number(b.expected_version_no)
  const conflict = () => res.status(409).json({ error: 'conflict' })

  try {
    if (b.action === 'approve') {
      const r = await db()
        .from('content_plan')
        .update({ review_status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .eq('version_no', expected)
        .in('review_status', ['ready_for_review', 'changes_requested', 'needs_data'])
        .select('id, review_status, version_no')
      if (r.error) throw r.error
      if (!r.data?.length) return void conflict()
      // Фото затвердженого поста — «використані», щоб підбір наступного разу брав інші
      await db().rpc('tl_mark_media_used', { p_plan_id: b.id })
      return void res.json({ ok: true, plan: r.data[0] })
    }

    if (b.action === 'swap_photo') {
      const slide = Number(b.slide_idx)
      if (!Number.isInteger(slide) || slide < 0 || slide > 9) return void res.status(400).json({ error: 'bad slide_idx' })
      const r = await db().rpc('tl_attach_photos', { p_plan_id: b.id, p_expected_version_no: expected, p_slide: slide })
      if (r.error) {
        if (r.error.code === 'P0409' || /version_conflict/.test(r.error.message)) return void conflict()
        throw r.error
      }
      const swapped = Boolean(r.data && (r.data as { id?: string }).id)
      return void res.json({ ok: true, swapped })
    }

    if (b.action === 'upload_url') {
      return void res.json({ ok: true, ...(await uploadUrl(b.id)) })
    }

    if (b.action === 'add_photo') {
      const path = String(b.path ?? '')
      if (!isUploadPath(b.id, path)) return void res.status(400).json({ error: 'bad path' })
      if (!(await uploadExists(path))) return void res.status(400).json({ error: 'файл не завантажився' })
      const p = await db().from('content_plan').select('hotel_id, review_status, version_no, current_version_id, published_at').eq('id', b.id).maybeSingle()
      if (p.error) throw p.error
      if (!p.data || p.data.version_no !== expected || p.data.published_at || p.data.review_status === 'regenerating') return void conflict()
      const v = p.data.current_version_id
        ? await db().from('post_versions').select('media_ids').eq('id', p.data.current_version_id).maybeSingle()
        : { data: { media_ids: [] as string[] }, error: null }
      if (v.error) throw v.error
      const dim = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 && (x as number) < 20000 ? (x as number) : null)
      const mediaId = await insertOwnMedia({ hotel_id: p.data.hotel_id, storage_path: path, width: dim(b.width), height: dim(b.height) })
      const ids = [...((v.data?.media_ids as string[] | undefined) ?? [])]
      const slide = Number(b.slide_idx)
      if (b.mode === 'replace' && Number.isInteger(slide) && slide >= 0 && slide < ids.length) ids[slide] = mediaId
      else ids.push(mediaId)
      const r = await db().rpc('tl_add_version', {
        p_content_plan_id: b.id, p_text: null, p_trigger: 'own_photo', p_expected_version_no: expected,
        p_media_ids: ids.slice(0, 10), p_prompt_version: 'own-photo', p_review_status: p.data.review_status,
      })
      if (r.error) {
        if (r.error.code === 'P0409' || /version_conflict/.test(r.error.message)) return void conflict()
        throw r.error
      }
      // Опис і теги — у фоні (n8n Vision), апці не чекати
      await notifyN8n({ media_id: mediaId }, 'travellab-media-describe')
      return void res.json({ ok: true, media_id: mediaId })
    }

    if (b.action === 'unapprove') {
      const r = await db()
        .from('content_plan')
        .update({ review_status: 'ready_for_review', approved_at: null, updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .eq('review_status', 'approved')
        .is('published_at', null)
        .select('id')
      if (r.error) throw r.error
      return r.data?.length ? void res.json({ ok: true }) : void conflict()
    }

    if (b.action === 'comment') {
      const text = (b.text ?? '').trim().slice(0, MAX_COMMENT)
      const photo = (b.photo ?? '').trim().slice(0, MAX_COMMENT)
      if (!text && !photo) return void res.status(400).json({ error: 'empty comment' })

      // Спершу «забираємо» пост у роботу — якщо хтось/щось уже змінило версію, нічого не пишемо
      const r = await db()
        .from('content_plan')
        .update({ review_status: 'regenerating', approved_at: null, updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .eq('version_no', expected)
        .in('review_status', ['ready_for_review', 'changes_requested', 'needs_data', 'approved'])
        .is('published_at', null)
        .select('id, current_version_id')
      if (r.error) throw r.error
      if (!r.data?.length) return void conflict()
      const versionId = r.data[0].current_version_id as string | null

      const rows = [
        text && { content_plan_id: b.id, version_id: versionId, target: 'text', body: text, chips: (b.chips_text ?? []).slice(0, 10), author_tg_id: user.id },
        photo && { content_plan_id: b.id, version_id: versionId, target: 'photo', body: photo, chips: (b.chips_photo ?? []).slice(0, 10), author_tg_id: user.id },
      ].filter(Boolean)
      const c = await db().from('review_comments').insert(rows).select('id, target')
      if (c.error) throw c.error

      const queued = await notifyN8n({ content_plan_id: b.id, expected_version_no: expected, comment_ids: (c.data ?? []).map((x) => x.id) })
      if (!queued) {
        // n8n недоступний / не налаштований — правка збережена, пост чекає ручної обробки
        await db().from('content_plan').update({ review_status: 'changes_requested' }).eq('id', b.id).eq('review_status', 'regenerating')
      }
      return void res.json({ ok: true, queued })
    }

    if (b.action === 'restore') {
      if (!b.version_id || !UUID.test(b.version_id)) return void res.status(400).json({ error: 'bad version_id' })
      const v = await db().from('post_versions').select('*').eq('id', b.version_id).eq('content_plan_id', b.id).maybeSingle()
      if (v.error) throw v.error
      if (!v.data) return void res.status(404).json({ error: 'version not found' })
      // Повернення = нова версія з текстом старої (історія не губиться)
      const r = await db().rpc('tl_add_version', {
        p_content_plan_id: b.id,
        p_text: v.data.text,
        p_trigger: 'manual',
        p_expected_version_no: expected,
        p_hooks: v.data.hooks,
        p_form: v.data.form,
        p_key_idea: v.data.key_idea,
        p_media_ids: v.data.media_ids,
        p_rendered_urls: v.data.rendered_urls,
        p_render_params: v.data.render_params,
        p_prompt_version: `restore v${v.data.version_no}`,
        p_review_status: 'ready_for_review',
      })
      if (r.error) {
        if (r.error.code === 'P0409' || /version_conflict/.test(r.error.message)) return void conflict()
        throw r.error
      }
      return void res.json({ ok: true, version: r.data })
    }

    res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    if (!failSchema(res, e)) fail(res, e)
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, fail, requireUser } from '../server/http.js'
import { insertOwnMedia, isUploadPath, uploadExists, uploadUrl } from '../server/media.js'
import { previewUrls, sendStory, sendToChat, type PhotoEdit } from '../server/render.js'
import { inquiryCounts, notifyN8n, openQuestions } from '../server/review.js'
import { DATE_RE, scheduleIfNeeded, TIME_RE } from '../server/schedule.js'
import { failSchema } from '../server/schema.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_COMMENT = 2000
const MAX_TEXT = 5000

type Body = {
  action?: 'approve' | 'comment' | 'restore' | 'unapprove' | 'swap_photo' | 'upload_url' | 'add_photo' | 'send_to_chat' | 'edit_text' | 'publish' | 'unpublish' | 'preview' | 'reschedule' | 'skip' | 'golden' | 'photo_edit' | 'send_story' | 'answer_data' | 'inquiry'
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
  date?: string
  time?: string
  on?: boolean
  media_id?: string
  edit?: Record<string, unknown>
  answers?: { id?: string; answer?: string }[]
}

const MAX_ANSWER = 1000
const MAX_PHOTO_TEXT = 140
// Чипи під фото: кожне поле — значення або null (= прибрати правку, як вирішив агент)
function parseEdit(raw: Record<string, unknown>): Record<string, string | null> | null {
  const out: Record<string, string | null> = {}
  const allowed: Record<string, string[] | 'text'> = { text: ['off', 'top', 'bottom'], look: ['none'], crop: ['centre', 'north', 'south'], title: 'text', kicker: 'text' }
  for (const [k, v] of Object.entries(raw)) {
    const rule = allowed[k]
    if (!rule) return null
    if (v === null) out[k] = null
    else if (rule === 'text') {
      if (typeof v !== 'string') return null
      out[k] = v.replace(/\s+/g, ' ').trim().slice(0, MAX_PHOTO_TEXT)
    } else if (typeof v === 'string' && rule.includes(v)) out[k] = v
    else return null
  }
  return Object.keys(out).length ? out : null
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
      // Одразу в календар: найближчий вільний день платформи (якщо дати ще нема)
      const slot = await scheduleIfNeeded(b.id).catch(() => null)
      return void res.json({ ok: true, plan: { ...r.data[0], ...(slot ?? {}) } })
    }

    // Іра міняє дату / час публікації в календарі
    if (b.action === 'reschedule') {
      const date = String(b.date ?? '')
      const time = String(b.time ?? '')
      if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return void res.status(400).json({ error: 'bad date' })
      if (!TIME_RE.test(time)) return void res.status(400).json({ error: 'bad time' })
      const r = await db()
        .from('content_plan')
        .update({ scheduled_for: date, slot_time: time, updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .is('published_at', null)
        .select('id, scheduled_for, slot_time')
      if (r.error) throw r.error
      return r.data?.length ? void res.json({ ok: true, plan: r.data[0] }) : void conflict()
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

    // Готовий вигляд фото (рамка + обробка + текст) — апка показує його замість сирого фото
    if (b.action === 'preview') {
      return void res.json({ ok: true, ...(await previewUrls(b.id)) })
    }

    // Готовий пост у чат бота: текст + фото з білою рамкою файлами — звідти Іра публікує
    if (b.action === 'send_to_chat') {
      return void res.json({ ok: true, ...(await sendToChat(b.id, user.id)) })
    }

    // Сторіз 9:16 з поточного фото — файлом у чат бота
    if (b.action === 'send_story') {
      const slide = Number(b.slide_idx)
      if (!Number.isInteger(slide) || slide < 0 || slide > 9) return void res.status(400).json({ error: 'bad slide_idx' })
      return void res.json({ ok: true, ...(await sendStory(b.id, user.id, slide)) })
    }

    // Іра сама виправила текст — нова версія як є, без агента (позначка ira_edit — для навчання, фаза 7)
    if (b.action === 'edit_text') {
      const text = (b.text ?? '').replace(/\r\n/g, '\n').trim()
      if (!text) return void res.status(400).json({ error: 'порожній текст' })
      if (text.length > MAX_TEXT) return void res.status(400).json({ error: 'задовгий текст' })
      const p = await db().from('content_plan').select('review_status, version_no, published_at').eq('id', b.id).maybeSingle()
      if (p.error) throw p.error
      if (!p.data || p.data.version_no !== expected || p.data.published_at || p.data.review_status === 'regenerating') return void conflict()
      const r = await db().rpc('tl_add_version', {
        p_content_plan_id: b.id, p_text: text, p_trigger: 'manual', p_expected_version_no: expected,
        p_prompt_version: 'ira_edit', p_review_status: p.data.review_status,
      })
      if (r.error) {
        if (r.error.code === 'P0409' || /version_conflict/.test(r.error.message)) return void conflict()
        throw r.error
      }
      return void res.json({ ok: true })
    }

    // Правка конкретного фото (без тексту / текст вгору-вниз / без обробки / інший кроп / свій текст на фото) —
    // нова версія з тим самим текстом поста, лише render_params.photo_edits; агент не задіяний, фото перемальовується одразу
    if (b.action === 'photo_edit') {
      const mid = String(b.media_id ?? '')
      const patch = parseEdit(b.edit ?? {})
      if (!mid || !patch) return void res.status(400).json({ error: 'bad edit' })
      const p = await db().from('content_plan').select('review_status, version_no, current_version_id, published_at').eq('id', b.id).maybeSingle()
      if (p.error) throw p.error
      if (!p.data?.current_version_id || p.data.version_no !== expected || p.data.published_at || p.data.review_status === 'regenerating') return void conflict()
      const v = await db().from('post_versions').select('media_ids, render_params').eq('id', p.data.current_version_id).maybeSingle()
      if (v.error) throw v.error
      if (!((v.data?.media_ids as string[] | null) ?? []).includes(mid)) return void res.status(400).json({ error: 'фото не з цього поста' })
      const params = (v.data?.render_params as Record<string, unknown> | null) ?? {}
      const edits = { ...((params.photo_edits as Record<string, PhotoEdit> | undefined) ?? {}) }
      const next: Record<string, unknown> = { ...(edits[mid] ?? {}) }
      for (const [k, val] of Object.entries(patch)) if (val === null) delete next[k]; else next[k] = val
      if (Object.keys(next).length) edits[mid] = next as PhotoEdit
      else delete edits[mid]
      const r = await db().rpc('tl_add_version', {
        p_content_plan_id: b.id, p_text: null, p_trigger: 'photo_edit', p_expected_version_no: expected,
        p_render_params: { ...params, photo_edits: edits }, p_prompt_version: 'photo_look', p_review_status: p.data.review_status,
      })
      if (r.error) {
        if (r.error.code === 'P0409' || /version_conflict/.test(r.error.message)) return void conflict()
        throw r.error
      }
      return void res.json({ ok: true })
    }

    // «Бракує даних»: Іра відповідає текстом на питання агента → data_requests.answer → n8n Data Answer
    // (факт у досьє готелю / туру + генерація поста). Не всі відповіді — зберігаємо, пост чекає решти
    if (b.action === 'answer_data') {
      const given = new Map<string, string>()
      for (const a of Array.isArray(b.answers) ? b.answers.slice(0, 20) : []) {
        const text = String(a?.answer ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_ANSWER)
        if (a?.id && UUID.test(a.id) && text) given.set(a.id, text)
      }
      if (!given.size) return void res.status(400).json({ error: 'порожні відповіді' })
      const p = await db().from('content_plan').select('id, hotel_id, tour_id, review_status, version_no, published_at').eq('id', b.id).maybeSingle()
      if (p.error) throw p.error
      if (!p.data || p.data.version_no !== expected || p.data.published_at || !['needs_data', 'ready_for_review', 'changes_requested'].includes(p.data.review_status)) return void conflict()
      const open = await openQuestions(p.data)
      const ids = open.map((q) => q.id).filter((x) => given.has(x))
      if (!ids.length) return void conflict()
      const remaining = open.length - ids.length
      // Усі відповіді є → спершу «забираємо» пост у роботу (захист від подвійного тапу), потім пишемо відповіді
      const regenerate = remaining === 0
      const was = p.data.review_status as string
      if (regenerate) {
        const c = await db().from('content_plan')
          .update({ review_status: 'regenerating', review_note: null, updated_at: new Date().toISOString() })
          .eq('id', b.id).eq('version_no', expected).eq('review_status', was).is('published_at', null)
          .select('id')
        if (c.error) throw c.error
        if (!c.data?.length) return void conflict()
      }
      const at = new Date().toISOString()
      for (const id of ids) {
        const r = await db().from('data_requests')
          .update({ answer: given.get(id), status: 'answered', answered_via: 'text', answered_at: at })
          .eq('id', id).eq('status', 'open')
        if (r.error) {
          if (regenerate) await db().from('content_plan').update({ review_status: was }).eq('id', b.id).eq('review_status', 'regenerating')
          throw r.error
        }
      }
      if (!regenerate) return void res.json({ ok: true, queued: false, remaining })
      const queued = await notifyN8n({ content_plan_id: b.id, expected_version_no: expected, author_tg_id: user.id, via: 'text', prev_status: was }, 'travellab-data-answer')
      if (!queued) {
        // n8n недоступний — відповіді збережені, пост допише ранковий Buffer Filler (бере вже дані відповіді)
        await db().from('content_plan').update({ review_status: was, review_note: 'Data Answer: n8n недоступний' }).eq('id', b.id).eq('review_status', 'regenerating')
      }
      return void res.json({ ok: true, queued, remaining: 0 })
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

    // Ручна публікація: Іра виклала пост сама → позначка в календарі (і навпаки, якщо помилилась)
    if (b.action === 'publish' || b.action === 'unpublish') {
      const toPublished = b.action === 'publish'
      const r = await db()
        .from('content_plan')
        .update({ review_status: toPublished ? 'published' : 'approved', published_at: toPublished ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .eq('review_status', toPublished ? 'approved' : 'published')
        .select('id')
      if (r.error) throw r.error
      return r.data?.length ? void res.json({ ok: true }) : void conflict()
    }

    // ⭐ «найкращий»: зірка на версії, яку Іра бачить зараз (приклад для генератора). Повторний тап знімає
    if (b.action === 'golden') {
      const plan = await db().from('content_plan').select('current_version_id').eq('id', b.id).eq('version_no', expected).maybeSingle()
      if (plan.error) throw plan.error
      if (!plan.data?.current_version_id) return void conflict()
      const on = b.on !== false
      const r = await db()
        .from('post_versions')
        .update({ is_golden: on, golden_at: on ? new Date().toISOString() : null })
        .eq('id', plan.data.current_version_id)
        .select('id')
      if (r.error) throw r.error
      return r.data?.length ? void res.json({ ok: true }) : void conflict()
    }

    // «💬 Написали з цього поста»: on=true → +1 звернення (рядок post_inquiries), on=false → зняти останнє.
    // Лише для викладених постів; без таблиці (SQL 014) — 503 schema_pending, апка кнопку й так не показує
    if (b.action === 'inquiry') {
      const p = await db().from('content_plan').select('review_status').eq('id', b.id).maybeSingle()
      if (p.error) throw p.error
      if (p.data?.review_status !== 'published') return void conflict()
      if (b.on !== false) {
        const r = await db().from('post_inquiries').insert({ content_plan_id: b.id, author_tg_id: user.id })
        if (r.error) throw r.error
      } else {
        const last = await db().from('post_inquiries').select('id').eq('content_plan_id', b.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1)
        if (last.error) throw last.error
        if (last.data?.length) {
          const d = await db().from('post_inquiries').delete().eq('id', last.data[0].id)
          if (d.error) throw d.error
        }
      }
      const counts = await inquiryCounts([b.id])
      return void res.json({ ok: true, inquiries: counts?.get(b.id) ?? 0 })
    }

    // Іра пропускає пост: зникає з черги й календаря (статус skipped — кінцевий)
    if (b.action === 'skip') {
      const r = await db()
        .from('content_plan')
        .update({ review_status: 'skipped', updated_at: new Date().toISOString() })
        .eq('id', b.id)
        .in('review_status', ['ready_for_review', 'changes_requested', 'needs_data', 'approved'])
        .is('published_at', null)
        .select('id')
      if (r.error) throw r.error
      return r.data?.length ? void res.json({ ok: true }) : void conflict()
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

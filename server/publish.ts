import { db, getSettings } from './http.js'
import { isDue, layoutPost, slotKey, type DueRow } from './publish_plan.js'
import { render, toHtml } from './render.js'

// Автопублікація затверджених TG-постів у канал Іри (§27 #12). Кличе n8n «[TravelLab] Autopublish TG» кожні 5 хв.
// Вмикається settings.autopublish_tg = "on" + settings.tg_channel_id (бот — адмін каналу). Без них нічого не робить.
// Замок від подвійної публікації: перед відправкою ставимо published_at (умова: approved і published_at порожній) —
// другий паралельний виклик рядок уже не візьме; апка теж не дає правити пост з published_at.
// SQL 013 (необов'язково для коду): autopublish_slot — слот, який уже пробували (не повторюємо після помилки),
// published_ref — куди і які message_id вийшли. Без колонок код працює, лише без цих двох позначок.

const MAX_PER_RUN = 2 // рендер + відправка ~10–20 с на пост; функція живе до 60 с
const DEFAULT_GRACE_MIN = 60

type Sent = { message_ids: number[] }

async function tgCall<T>(method: string, body: FormData | object): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set')
  const isForm = body instanceof FormData
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
  })
  const j = (await r.json()) as { ok: boolean; result?: T; description?: string }
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`)
  return j.result as T
}

const isMissingColumn = (e: unknown) => {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  return code === '42703' || code === 'PGRST204'
}

// update з необов'язковими колонками SQL 013: якщо їх ще нема — повтор без них
async function updatePlan(id: string, base: Record<string, unknown>, extra: Record<string, unknown>, match: (q: any) => any) {
  const run = (patch: Record<string, unknown>) => match(db().from('content_plan').update(patch).eq('id', id)).select('id')
  let r = await run({ ...base, ...extra })
  if (r.error && isMissingColumn(r.error)) r = await run(base)
  if (r.error) throw r.error
  return (r.data ?? []) as { id: string }[]
}

// Фото як фото (не файлом): у каналі читач бачить пост, а не вкладення. Підпис — на першому фото альбому
async function sendPost(chatId: string, text: string, files: { name: string; buf: Buffer }[], sent: Sent) {
  const lay = layoutPost(text, files.length)
  const blob = (b: Buffer) => new Blob([new Uint8Array(b)], { type: 'image/jpeg' })
  if (files.length === 1) {
    const f = new FormData()
    f.append('chat_id', chatId)
    f.append('photo', blob(files[0].buf), files[0].name)
    if (lay.caption) {
      f.append('caption', toHtml(lay.caption))
      f.append('parse_mode', 'HTML')
    }
    const m = await tgCall<{ message_id: number }>('sendPhoto', f)
    sent.message_ids.push(m.message_id)
  } else if (files.length > 1) {
    const f = new FormData()
    f.append('chat_id', chatId)
    f.append('media', JSON.stringify(files.map((_, i) => ({
      type: 'photo', media: `attach://f${i}`,
      ...(i === 0 && lay.caption ? { caption: toHtml(lay.caption), parse_mode: 'HTML' } : {}),
    }))))
    files.forEach((x, i) => f.append(`f${i}`, blob(x.buf), x.name))
    const ms = await tgCall<{ message_id: number }[]>('sendMediaGroup', f)
    sent.message_ids.push(...ms.map((m) => m.message_id))
  }
  for (const part of lay.messages) {
    const m = await tgCall<{ message_id: number }>('sendMessage', { chat_id: chatId, text: toHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    sent.message_ids.push(m.message_id)
  }
  return lay.mode
}

async function titleOf(p: { hotel_id?: string | null; tour_id?: string | null; pillar?: string | null }) {
  if (p.hotel_id) {
    const h = await db().from('hotels').select('name').eq('hotel_id', p.hotel_id).maybeSingle()
    if (h.data?.name) return String(h.data.name)
  }
  if (p.tour_id) {
    const t = await db().from('tours').select('title').eq('tour_id', p.tour_id).maybeSingle()
    if (t.data?.title) return String(t.data.title)
  }
  return p.pillar || 'пост'
}

async function notifyAdmin(adminChat: string, text: string) {
  if (!adminChat) return
  await tgCall('sendMessage', { chat_id: adminChat, text }).catch(() => null)
}

// Скільки фото реально піде (є файл у Storage) — для dry_run без рендеру
async function photoCount(versionId: string): Promise<{ text: string; photos: number }> {
  const v = await db().from('post_versions').select('text, media_ids').eq('id', versionId).maybeSingle()
  if (v.error) throw v.error
  const ids = ((v.data?.media_ids as string[] | null) ?? []).slice(0, 10)
  const m = ids.length ? await db().from('media').select('media_id, storage_path').in('media_id', ids) : { data: [], error: null }
  if (m.error) throw m.error
  const has = new Set((m.data ?? []).filter((x) => x.storage_path).map((x) => x.media_id as string))
  return { text: String(v.data?.text ?? ''), photos: ids.filter((id) => has.has(id)).length }
}

export type PublishOpts = { dryRun: boolean; planId?: string; chatOverride?: string }

export async function publishDue(opts: PublishOpts) {
  const s = await getSettings(['autopublish_tg', 'tg_channel_id', 'admin_chat_id', 'autopublish_grace_min'])
  const enabled = s.autopublish_tg === 'on'
  const channel = s.tg_channel_id == null ? '' : String(s.tg_channel_id).trim()
  const adminChat = s.admin_chat_id == null ? '' : String(s.admin_chat_id).trim()
  const graceMin = Number(s.autopublish_grace_min) > 0 ? Number(s.autopublish_grace_min) : DEFAULT_GRACE_MIN

  // Тест відправки: лише в чат Влада (admin_chat_id), лише конкретний пост, статус не змінюється
  const test = Boolean(opts.chatOverride)
  if (test) {
    if (!opts.planId) return { ok: false, error: 'для тесту потрібен plan_id' }
    if (!adminChat || opts.chatOverride !== adminChat) return { ok: false, error: 'тестова відправка — лише в admin_chat_id' }
  }
  const target = test ? adminChat : channel
  const base = { ok: true, enabled, channel_set: Boolean(channel), dry_run: opts.dryRun, test }
  if (!opts.dryRun && !test && (!enabled || !channel)) return { ...base, skipped: !enabled ? 'off' : 'no_channel', published: [] }

  let q = db().from('content_plan').select('*').eq('platform', 'telegram')
  if (opts.planId) q = q.eq('id', opts.planId)
  else q = q.eq('review_status', 'approved').is('published_at', null).not('scheduled_for', 'is', null)
  const r = await q
  if (r.error) throw r.error
  const now = Date.now()
  const rows = (r.data ?? []) as (DueRow & { hotel_id: string | null; tour_id: string | null; pillar: string | null })[]
  const due = test ? rows.filter((p) => p.current_version_id) : rows.filter((p) => isDue(p, now, graceMin))
  due.sort((a, b) => slotKey(a.scheduled_for, a.slot_time).localeCompare(slotKey(b.scheduled_for, b.slot_time)))

  if (opts.dryRun) {
    const would = await Promise.all(due.map(async (p, i) => {
      const { text, photos } = await photoCount(p.current_version_id!)
      const lay = layoutPost(text, photos)
      return {
        id: p.id, title: await titleOf(p), slot: slotKey(p.scheduled_for, p.slot_time), this_run: i < MAX_PER_RUN,
        to: target || null, mode: lay.mode, photos, caption_len: lay.caption?.length ?? 0, text_messages: lay.messages.length,
        text_preview: text.replace(/\*\*/g, '').slice(0, 120),
      }
    }))
    return { ...base, grace_min: graceMin, would_publish: would }
  }

  const published: unknown[] = []
  const errors: unknown[] = []
  for (const p of due.slice(0, MAX_PER_RUN)) {
    const slot = slotKey(p.scheduled_for, p.slot_time)
    const sent: Sent = { message_ids: [] }
    if (test) {
      try {
        const r = await render(p.id)
        const mode = await sendPost(target, r.text, r.files, sent)
        published.push({ id: p.id, test: true, mode, message_ids: sent.message_ids })
      } catch (e) {
        errors.push({ id: p.id, error: e instanceof Error ? e.message : String(e), sent: sent.message_ids.length })
      }
      continue
    }

    // Замок: забираємо пост, лише якщо його ще ніхто не виклав
    const lockAt = new Date().toISOString()
    const locked = await updatePlan(p.id, { published_at: lockAt }, { autopublish_slot: slot },
      (q) => q.eq('review_status', 'approved').is('published_at', null))
    if (!locked.length) continue

    try {
      const r = await render(p.id)
      const mode = await sendPost(target, r.text, r.files, sent)
      await updatePlan(p.id, { review_status: 'published', updated_at: new Date().toISOString() },
        { published_ref: { chat_id: target, message_ids: sent.message_ids, mode, auto: true } },
        (q) => q.eq('published_at', lockAt))
      published.push({ id: p.id, slot, mode, message_ids: sent.message_ids })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const title = await titleOf(p).catch(() => 'пост')
      if (!sent.message_ids.length) {
        // Нічого не вийшло — знімаємо замок: пост лишається «до публікації», Іра/Влад викладуть вручну
        await updatePlan(p.id, { published_at: null }, {}, (q) => q.eq('published_at', lockAt)).catch(() => null)
        await notifyAdmin(adminChat, `⚠️ Автопублікація в канал не вдалась\n${slot} · ${title}\n${msg.slice(0, 500)}\n\nПост лишився «до публікації» — виклади вручну.`)
      } else {
        // Частина вже в каналі — замок лишаємо, щоб не задублювати; розібратись руками
        await notifyAdmin(adminChat, `⚠️ Автопублікація вийшла частково (${sent.message_ids.length} повідомл.)\n${slot} · ${title}\n${msg.slice(0, 500)}\n\nПеревір канал. Повторно сам не викладу.`)
      }
      errors.push({ id: p.id, slot, error: msg, sent: sent.message_ids.length })
    }
  }
  return { ...base, published, errors, due: due.length }
}

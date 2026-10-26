import { db, getSettings } from './http.js'
import { tgCall } from './publish.js'
import { CAPTION_MAX, splitText, videoDue } from './publish_plan.js'

// Публікація готових сторіз / рілс (сет 7, SQL 022). Кличе api/publish.ts — той самий n8n WF-052 кожні 5 хв, що й для постів.
// Telegram-канал (платформа telegram, autopublish_tg = on + tg_channel_id): у слот sendVideo в канал з підписом → published_at.
// Instagram (і TG, поки канал не підключено): у слот бот шле Ірі в чат готовий файл, для рілсу ще версію без музики
// й обкладинку файлом, останнім — підпис з кнопкою «✅ Виклала» (callback vpub_<id> → бот WF-055 ставить published_at).
// Замок від подвійної відправки — як у постах: спершу позначка (published_at / delivered_at) з умовою «ще порожньо», потім Telegram.
// Скасувати з апки: «Повернути на перегляд» до слоту (статус уже не approved — відео не візьмемо).

const BUCKET = 'video'
const MAX_PER_RUN = 2
const DEFAULT_GRACE_MIN = 60
const COLS = 'id, name, format, platform, place, dur, status, scheduled_for, final_path, cover_path, nomusic_path, tg_file_id, caption, published_at, delivered_at, publish_slot, montage'
const FORMAT: Record<string, string> = { stories: 'сторіз', reel: 'рілс' }
const PLAT: Record<string, string> = { instagram: 'Instagram', telegram: 'Telegram' }

type Row = {
  id: string; name: string; format: string; platform: string; place: string; dur: number | string; status: string; scheduled_for: string | null
  final_path: string | null; cover_path: string | null; nomusic_path: string | null; tg_file_id: string | null; caption: string | null
  published_at: string | null; delivered_at: string | null; publish_slot: string | null; montage: { voice?: unknown } | null
}
type Msg = { message_id: number; video?: { file_id: string } }

const kyivSlot = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))

async function download(path: string): Promise<Blob> {
  const r = await db().storage.from(BUCKET).download(path)
  if (r.error) throw r.error
  return r.data
}

// Готове відео: є file_id з першої відправки (final_worker.py) — без повторного завантаження; інакше файл зі Storage
async function sendVideo(chat: string, d: Row, which: 'final' | 'nomusic', caption: string, ids: number[]) {
  const f = new FormData()
  f.append('chat_id', chat)
  if (caption) f.append('caption', caption)
  f.append('supports_streaming', 'true')
  const path = which === 'final' ? d.final_path! : d.nomusic_path!
  if (which === 'final' && d.tg_file_id) f.append('video', d.tg_file_id)
  else {
    const [v, c] = await Promise.all([download(path), d.cover_path ? download(d.cover_path).catch(() => null) : Promise.resolve(null)])
    f.append('video', v, which === 'final' ? 'final.mp4' : 'final_nomusic.mp4')
    f.append('width', '1080')
    f.append('height', '1920')
    f.append('duration', String(Math.round(Number(d.dur))))
    if (c) { f.append('cover', 'attach://cv'); f.append('cv', c, 'cover.jpg') }
  }
  const m = await tgCall<Msg>('sendVideo', f)
  ids.push(m.message_id)
  return m.video?.file_id ?? null
}

// Канал: відео з підписом; підпис довший за 1024 — відео, а текст окремими повідомленнями
async function toChannel(chat: string, d: Row, ids: number[]) {
  const text = (d.caption ?? '').trim()
  const fits = text.length <= CAPTION_MAX
  await sendVideo(chat, d, 'final', fits ? text : '', ids)
  if (!fits) {
    for (const part of splitText(text)) {
      const m = await tgCall<Msg>('sendMessage', { chat_id: chat, text: part, link_preview_options: { is_disabled: true } })
      ids.push(m.message_id)
    }
  }
}

// Чат Іри: «виклади зараз» — файли по черзі, підпис останнім (затиснути → Копіювати), під ним «✅ Виклала»
async function toChat(chat: string, d: Row, ids: number[], test: boolean) {
  const plat = PLAT[d.platform] ?? 'Instagram'
  const reel = d.format === 'reel'
  const text = (d.caption ?? '').trim()
  // версія без музики й обкладинка файлом — лише для Instagram (там своя музика й окрема обкладинка)
  const ig = d.platform !== 'telegram'
  const nomusic = reel && ig && d.nomusic_path
  const cover = reel && ig ? d.cover_path : null
  const head = `${test ? '🧪 Тест · ' : ''}📲 Час викласти ${FORMAT[d.format] ?? 'відео'} «${d.name}» в ${plat}`
  const how = [
    nomusic ? 'Це версія з музикою. Нижче — та сама без музики, якщо хочеш поставити трек з Instagram.' : '',
    cover ? 'Обкладинка — окремим файлом.' : '',
    text ? 'Підпис — останнім повідомленням: затисни його → «Копіювати».' : reel ? 'Підпис напиши свій — агент його не склав.' : '',
    'Виклала — натисни «✅ Виклала» внизу.',
  ].filter(Boolean).join('\n')
  await sendVideo(chat, d, 'final', `${head}\n\n${how}`, ids)
  if (nomusic) {
    const voice = d.montage?.voice ? ' Голос лишився.' : ''
    await sendVideo(chat, d, 'nomusic', `Без музики — для треку з бібліотеки Instagram.${voice}`, ids)
  }
  if (cover) {
    const f = new FormData()
    f.append('chat_id', chat)
    f.append('caption', 'Обкладинка для рілсу: в Instagram «Обкладинка» → «Додати з галереї»')
    f.append('document', await download(cover), 'cover.jpg')
    ids.push((await tgCall<Msg>('sendDocument', f)).message_id)
  }
  const last = text || `Виклади «${d.name}» у ${reel ? 'стрічку' : 'сторіз'} ${plat} і натисни, коли готово.`
  const m = await tgCall<Msg>('sendMessage', {
    chat_id: chat, text: last.slice(0, 4096), link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: '✅ Виклала', callback_data: `vpub_${d.id}` }]] },
  })
  ids.push(m.message_id)
}

async function notifyAdmin(adminChat: string, text: string) {
  if (!adminChat) return
  await tgCall('sendMessage', { chat_id: adminChat, text }).catch(() => null)
}

export type VideoPublishOpts = { dryRun: boolean; videoId?: string; chatOverride?: string; as?: 'channel' | 'chat' }

export async function publishVideos(opts: VideoPublishOpts) {
  const s = await getSettings(['autopublish_tg', 'tg_channel_id', 'admin_chat_id', 'ira_chat_id', 'autopublish_grace_min', 'video_ig_send', 'tg_test_channel_id'])
  const str = (v: unknown) => (v == null ? '' : String(v).trim())
  const channel = s.autopublish_tg === 'on' ? str(s.tg_channel_id) : ''
  const ira = str(s.ira_chat_id)
  const adminChat = str(s.admin_chat_id)
  const chatOn = s.video_ig_send !== 'off' && Boolean(ira)
  const graceMin = Number(s.autopublish_grace_min) > 0 ? Number(s.autopublish_grace_min) : DEFAULT_GRACE_MIN

  // Тест: конкретне відео в чат Влада або тестовий канал; статус і позначки не змінюються
  const test = Boolean(opts.chatOverride)
  if (test) {
    if (!opts.videoId) return { ok: false, error: 'для тесту потрібен video_id' }
    const allowed = [adminChat, str(s.tg_test_channel_id)].filter(Boolean)
    if (!allowed.includes(opts.chatOverride!)) return { ok: false, error: 'тестова відправка — лише в admin_chat_id або settings.tg_test_channel_id' }
  }
  const base = { ok: true, channel_set: Boolean(channel), chat_on: chatOn, dry_run: opts.dryRun, test }

  let q = db().from('video_drafts').select(COLS)
  if (opts.videoId) q = q.eq('id', opts.videoId)
  else q = q.eq('status', 'approved').is('published_at', null).is('delivered_at', null).not('final_path', 'is', null)
    .not('scheduled_for', 'is', null).lte('scheduled_for', new Date().toISOString())
  const r = await q
  if (r.error) throw r.error
  const now = Date.now()
  const rows = (r.data ?? []) as Row[]
  const due = test
    ? rows.filter((d) => d.final_path).map((d) => ({ d, mode: opts.as ?? (opts.chatOverride!.startsWith('-') ? 'channel' : 'chat') }))
    : rows.map((d) => ({ d, mode: videoDue(d, now, { channel: Boolean(channel), chatOn, graceMin }) })).filter((x) => x.mode)
  due.sort((a, b) => String(a.d.scheduled_for).localeCompare(String(b.d.scheduled_for)))

  if (opts.dryRun) {
    return {
      ...base, grace_min: graceMin,
      would_send: due.map(({ d, mode }, i) => ({
        id: d.id, name: d.name, format: d.format, platform: d.platform, slot: d.scheduled_for, mode, this_run: i < MAX_PER_RUN,
        to: test ? opts.chatOverride : mode === 'channel' ? channel : ira, nomusic: Boolean(d.nomusic_path), caption_len: (d.caption ?? '').length,
      })),
    }
  }

  const sent: unknown[] = []
  const errors: unknown[] = []
  for (const { d, mode } of due.slice(0, MAX_PER_RUN)) {
    const ids: number[] = []
    const target = test ? opts.chatOverride! : mode === 'channel' ? channel : ira
    if (test) {
      try {
        if (mode === 'channel') await toChannel(target, d, ids)
        else await toChat(target, d, ids, true)
        sent.push({ id: d.id, test: true, mode, message_ids: ids })
      } catch (e) {
        errors.push({ id: d.id, error: e instanceof Error ? e.message : String(e), sent: ids.length })
      }
      continue
    }

    // Замок: канал — published_at (вийшло), чат — delivered_at (надіслано Ірі); обидва з умовою «відео те саме й ще не відправлене»
    const lockAt = new Date().toISOString()
    const mark = mode === 'channel' ? 'published_at' : 'delivered_at'
    const locked = await db().from('video_drafts').update({ [mark]: lockAt, publish_slot: d.scheduled_for })
      .eq('id', d.id).eq('status', 'approved').eq('final_path', d.final_path!).is('published_at', null).is('delivered_at', null).select('id')
    if (locked.error) throw locked.error
    if (!locked.data?.length) continue

    const slot = kyivSlot(d.scheduled_for!)
    try {
      if (mode === 'channel') await toChannel(target, d, ids)
      else await toChat(target, d, ids, false)
      // updated_at не чіпаємо: відправка — не правка (відкритий редактор не отримає 409)
      await db().from('video_drafts').update({ published_ref: { chat_id: target, message_ids: ids, via: mode } }).eq('id', d.id).eq(mark, lockAt)
      sent.push({ id: d.id, mode, message_ids: ids })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const where = mode === 'channel' ? 'в канал' : 'Ірі в чат'
      if (!ids.length) {
        // нічого не вийшло — знімаємо позначку; слот лишається «пробуваним» (publish_slot), повтору автоматом не буде
        await db().from('video_drafts').update({ [mark]: null }).eq('id', d.id).eq(mark, lockAt)
        await notifyAdmin(adminChat, `⚠️ Відео не вдалось надіслати ${where}\n${slot} · «${d.name}»\n${msg.slice(0, 500)}\n\nВідео лишилось затвердженим — «Надіслати ще раз» в апці й виклади вручну.`)
      } else {
        await notifyAdmin(adminChat, `⚠️ Відео надіслано ${where} частково (${ids.length} повідомл.)\n${slot} · «${d.name}»\n${msg.slice(0, 500)}\n\nПеревір. Повторно сам не надсилатиму.`)
      }
      errors.push({ id: d.id, mode, error: msg, sent: ids.length })
    }
  }
  return { ...base, sent, errors, due: due.length }
}

// «✅ Виклала» з апки (бот WF-055 робить те саме напряму в Supabase): опубліковано → редагування закрите
export async function markPosted(id: string, userId: number): Promise<{ published_at: string } | 'not_found' | 'not_ready'> {
  const cur = await db().from('video_drafts').select('status, final_path, published_at, published_ref').eq('id', id).maybeSingle()
  if (cur.error) throw cur.error
  if (!cur.data) return 'not_found'
  if (cur.data.published_at) return { published_at: String(cur.data.published_at) }
  if (cur.data.status !== 'approved' || !cur.data.final_path) return 'not_ready'
  const published_at = new Date().toISOString()
  const ref = { ...((cur.data.published_ref as Record<string, unknown> | null) ?? {}), posted_via: 'app', posted_by: userId }
  const r = await db().from('video_drafts').update({ published_at, published_ref: ref }).eq('id', id).is('published_at', null).select('published_at')
  if (r.error) throw r.error
  return { published_at: String(r.data?.[0]?.published_at ?? published_at) }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, getPost, hotelAction, reviewAction, type PhotoEdit, type PostDetail, type PostWm, type Version } from '../lib/api'
import { prepareAll, uploadSequential, type PreparedPhoto } from '../lib/image'
import type { PhotoSpec, StyleKey } from '../lib/photoSpec'
import { diffWords, renderDiff, renderPost } from '../lib/text'
import { confirmAction, haptic, isDemo, useBackButton } from '../lib/tg'
import { AudienceCard } from './AudienceCard'
import { Carousel } from './Carousel'
import { DataQuestions } from './DataQuestions'
import { whenLabel } from './CalendarScreen'
import { Inquiries } from './Inquiries'
import { PhotoEditor } from './PhotoEditor'
import { Center, Label, Spinner } from './ui'

export const PLATFORM: Record<string, { name: string; cls: string }> = {
  telegram: { name: 'Telegram', cls: 'tg' },
  instagram: { name: 'Instagram', cls: 'ig' },
  threads: { name: 'Threads', cls: 'th' },
}

export const PILLAR: Record<string, string> = {
  tour_offer: 'тур-пропозиція', tour_offer_fallback: 'тур', tour_offer_seasonal: 'сезонний тур', tour_expert: 'експертна думка',
  hotel_place: 'про готель', insider: 'інсайдер', atmosphere: 'атмосфера', personal: 'особисте', personal_take: 'думка',
  behind_scenes: 'закулісся', video: 'відео', template: 'шаблон', unusual_hotels: 'незвичайні готелі', personal_experience: 'історія Іри',
}

const FORM: Record<string, string> = { one_fact: 'один факт', list: 'перелік', story: 'історія', question: 'питання', comparison: 'порівняння' }

const CHIPS_TEXT = ['Коротше', 'Тепліше, більше мене', 'Без ціни', 'Інший початок', 'Більше фактів']
// Підказки до «До фото» — лише те, що вміє парсер у WF-046 (→ photo_edits); чипи під самим фото діють одразу, без агента
const CHIPS_PHOTO = ['Прибери текст з фото', 'Текст вниз', 'Більше затемнення', 'Текст ширше', 'Без обробки']

// «Інший кроп» по колу: як вирішив агент → центр → верх → низ → знову агент
const CROPS: (PhotoEdit['crop'] | undefined)[] = [undefined, 'centre', 'north', 'south']
// Водяні знаки Іри для фото поста (сторіз — завжди коло)
const WM_NAME: Record<PostWm, string> = { wm1: 'Довгий', wm3: 'Рукописний', off: 'Без знака' }
const WM_DONE: Record<PostWm, string> = { wm1: 'Знак: довгий горизонтальний', wm3: 'Знак: рукописний', off: 'Без водяного знака' }
const CROP_NAME: Record<string, string> = { centre: 'центр', north: 'верх', south: 'низ' }

const POLL_MS = 5000

type Props = {
  id: string
  index: number
  total: number
  doneIds: Set<string>
  order: string[]
  onBack: () => void
  onNext: () => void
  onChanged: () => void
}

export function PostScreen({ id, index, total, doneIds, order, onBack, onNext, onChanged }: Props) {
  const [post, setPost] = useState<PostDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'new' | 'old'>('new')
  const [showDiff, setShowDiff] = useState(true)
  const [cText, setCText] = useState('')
  const [cPhoto, setCPhoto] = useState('')
  const [chipsT, setChipsT] = useState<string[]>([])
  const [chipsP, setChipsP] = useState<string[]>([])
  const [toast, setToast] = useState('')
  const [slide, setSlide] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const [own, setOwn] = useState<PreparedPhoto[]>([])
  const [progress, setProgress] = useState('')
  const [ownMode, setOwnMode] = useState<'replace' | 'add'>('add')
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  // Готовий вигляд фото поточної версії (рамка + обробка + текст) — рендерить сервер
  const [ready, setReady] = useState<{ version: string; key: string; urls: (string | null)[] } | null>(null)
  const [rendering, setRendering] = useState(false)
  // Редактор тексту на фото (сет 5): повноекранний лист для одного фото
  const [editor, setEditor] = useState<{ mid: string; slide: number } | null>(null)

  useBackButton(!editor, onBack)

  const load = useCallback(async () => {
    try {
      setPost(await getPost(id))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [id])

  useEffect(() => {
    setPost(null)
    setView('new')
    setSlide(0)
    setCText(''); setCPhoto(''); setChipsT([]); setChipsP([])
    setDraft(null)
    setEditor(null)
    void load()
  }, [load])

  // Поки агент переробляє — тихо перечитуємо, щоб нова версія з'явилась сама
  const regenerating = post?.plan.review_status === 'regenerating'
  useEffect(() => {
    if (!regenerating) return
    const t = setInterval(() => void load().then(onChanged), POLL_MS)
    return () => clearInterval(t)
  }, [regenerating, load, onChanged])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(t)
  }, [toast])

  const cur = useMemo(() => post?.versions.find((v) => v.id === post.plan.current_version_id) ?? post?.versions.at(-1), [post])
  const prev = useMemo(() => {
    if (!post || !cur) return undefined
    return [...post.versions].reverse().find((v) => v.version_no < cur.version_no && v.text !== cur.text)
  }, [post, cur])
  const askedFor = useMemo(() => post?.comments.filter((c) => cur?.comment_id && c.id === cur.comment_id) ?? [], [post, cur])
  const pending = useMemo(() => post?.comments.filter((c) => c.status === 'new' || c.status === 'processing') ?? [], [post])
  // Правка до фото, яку автоматично не зробили (лишилась «new»): з того ж запиту, що й поточна версія, — показуємо, щоб не зникла
  const photoLater = useMemo(() => {
    if (!post || !cur) return []
    const from = new Set([cur.id, ...askedFor.map((c) => c.version_id)])
    return post.comments.filter((c) => c.target === 'photo' && c.status === 'new' && c.id !== cur.comment_id && c.version_id && from.has(c.version_id))
  }, [post, cur, askedFor])

  const curId = cur?.id
  const curPhotos = (cur?.media_ids ?? []).length
  const curKey = (cur?.media_ids ?? []).join(',')
  useEffect(() => {
    if (!post || !curId || !curPhotos) return
    let alive = true
    setRendering(true)
    reviewAction(post.plan.id, post.plan.version_no, 'preview')
      .then((r) => { if (alive) setReady({ version: curId, key: curKey, urls: r.urls ?? [] }) })
      .catch(() => { if (alive) setReady(null) }) // не вийшло — лишається сире фото, «Надіслати в чат» все одно оброблить
      .finally(() => { if (alive) setRendering(false) })
    return () => { alive = false }
    // лише коли змінилась версія (нове фото / текст)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curPhotos])

  if (error && !post) return <Center><p style={{ color: 'var(--hint)' }}>Не вдалося завантажити пост. {error}</p><button className="btn sec mt-4" onClick={() => void load()}>Спробувати ще</button></Center>
  if (!post) return <Center><Spinner /></Center>

  const plat = PLATFORM[post.plan.platform] ?? { name: post.plan.platform, cls: '' }
  const status = post.plan.review_status
  const questions = status === 'published' || status === 'approved' ? [] : post.questions ?? []

  const act = async (action: 'approve' | 'unapprove' | 'comment' | 'restore' | 'swap_photo' | 'upload_url' | 'add_photo' | 'send_to_chat' | 'edit_text' | 'publish' | 'unpublish' | 'reschedule' | 'skip' | 'unskip' | 'golden' | 'photo_edit' | 'send_story' | 'answer_data' | 'watermark' | 'photo_spec', extra = {}) => {
    setBusy(true)
    try {
      const r = await reviewAction(post.plan.id, post.plan.version_no, action, extra)
      return r
    } catch (e) {
      haptic('error')
      if (e instanceof ApiError && e.status === 409) {
        setToast('Пост щойно змінився — оновила')
        await load()
      } else setToast(e instanceof Error ? e.message : 'Помилка')
      return null
    } finally {
      setBusy(false)
    }
  }

  // Відповіді на питання агента: всі → пост «переробляю», частина → збережено, решта чекає
  const answer = async (answers: { id: string; answer: string }[]) => {
    const r = await act('answer_data', { answers })
    if (!r) return false
    haptic('success')
    if (r.remaining) setToast(`Збережено. Лишилось питань: ${r.remaining}`)
    else if (r.queued) {
      setPost((p) => (p ? { ...p, plan: { ...p.plan, review_status: 'regenerating' } } : p))
      setToast('Дякую! Дописую пост — напишу в чат, коли буде готово')
    } else setToast('Відповіді збережено — пост допишу трохи згодом')
    await load()
    onChanged()
    return true
  }

  if (!cur) return <NoTextYet post={post} plat={plat} questions={questions} busy={busy} toast={toast} total={total} onAnswer={answer} onNext={onNext} />

  // Опублікований = затверджений + викладений: так само без правок
  const published = status === 'published'
  const approved = status === 'approved' || published
  const shown: Version = view === 'old' && prev ? prev : cur
  const hasComment = Boolean(cText.trim() || cPhoto.trim())
  const missing = (cur.missing_facts ?? []).filter((m) => m && (m.note || m.field))

  const approve = async () => {
    const r = await act('approve')
    if (!r) return
    haptic('success')
    const at = r.plan?.scheduled_for ? ` → ${whenLabel(r.plan.scheduled_for, r.plan.slot_time ?? null)}` : ''
    setToast(`Затверджено · ${plat.name}${at}`)
    onChanged()
    setTimeout(onNext, 450)
  }

  const redo = async () => {
    const r = await act('comment', { text: cText, photo: cPhoto, chips_text: chipsT, chips_photo: chipsP })
    if (!r) return
    haptic('success')
    setCText(''); setCPhoto(''); setChipsT([]); setChipsP([])
    // Одразу показуємо «переробляю», не чекаючи перечитування
    setPost((p) => (p ? { ...p, plan: { ...p.plan, review_status: r.queued ? 'regenerating' : 'changes_requested' } } : p))
    setToast(r.queued ? 'Переробляю — напишу в чат, коли буде готово' : 'Правку збережено, Влад підхопить')
    await load()
    onChanged()
  }

  const restore = async () => {
    if (!prev || !(await act('restore', { version_id: prev.id }))) return
    haptic('success')
    setView('new')
    setToast(`Повернула версію ${prev.version_no}`)
    await load()
    onChanged()
  }

  const swapPhoto = async () => {
    const r = await act('swap_photo', { slide_idx: slide })
    if (!r) return
    haptic('success')
    setToast(r.swapped ? 'Поставила інше фото' : 'Інших фото цього готелю поки немає')
    await load()
  }

  // Можна обрати кілька фото одразу (до 10 у каруселі разом із вже доданими)
  const pickOwn = async (list: FileList | null) => {
    const left = Math.max(0, 10 - (shown.media_ids ?? []).length)
    const files = Array.from(list ?? [])
    if (!files.length) return
    if (!left) return setToast('У каруселі вже 10 фото — максимум')
    setProgress('Готую фото…')
    const r = await prepareAll(files.slice(0, left))
    setProgress('')
    if (files.length > left) setToast(`Взяла перші ${left} — більше 10 у каруселі не буває`)
    else if (r.failed) setToast(r.ok.length ? `${r.failed} фото не відкрилось — решту взяла` : r.lastError || 'Не вдалося відкрити фото')
    if (!r.ok.length) return
    setOwn((old) => [...old, ...r.ok].slice(0, left))
    setOwnMode((shown.media_ids ?? []).length && r.ok.length === 1 ? 'replace' : 'add')
  }

  const cancelOwn = () => {
    own.forEach((p) => URL.revokeObjectURL(p.preview))
    setOwn([])
  }

  const dropOwn = (i: number) => {
    URL.revokeObjectURL(own[i].preview)
    setOwn((o) => o.filter((_, k) => k !== i))
  }

  // Свої фото: кожне — підписане посилання й файл прямо в Storage (по черзі), потім ОДНА нова версія поста.
  // Текст і статус поста не змінюються — тож працює і на затвердженому
  const uploadOwn = async () => {
    if (!own.length) return
    setUploading(true)
    try {
      const { items, failed } = await uploadSequential(own, async () => {
        const u = await reviewAction(post.plan.id, post.plan.version_no, 'upload_url')
        return { path: u.path ?? '', signed_url: u.signed_url }
      }, isDemo, (d, t) => setProgress(t > 1 ? `Завантажую ${Math.min(d + 1, t)} з ${t}…` : ''))
      if (!items.length) throw new Error('Фото не завантажились — перевір інтернет і спробуй ще раз')
      const r = await act('add_photo', { items, mode: ownMode, slide_idx: slide })
      if (!r) return
      haptic('success')
      setToast(failed
        ? `Додала ${items.length}, ${failed} не завантажилось — спробуй ті ще раз`
        : items.length > 1 ? `Додала ${items.length} фото — тапни «✎ Текст на фото» на кожному` : 'Фото додано — зараз оброблю і покажу готове')
      own.forEach((p) => URL.revokeObjectURL(p.preview))
      setOwn([])
      await load()
      onChanged()
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : 'Фото не завантажилось')
    } finally {
      setProgress('')
      setUploading(false)
    }
  }

  // Своя редакція тексту: зберігається як нова версія без агента
  const saveDraft = async () => {
    if (draft === null) return
    if (draft.trim() === (cur.text ?? '').trim()) return setDraft(null)
    if (!(await act('edit_text', { text: draft }))) return
    haptic('success')
    setDraft(null)
    setToast('Збережено як нову версію')
    await load()
    onChanged()
  }

  // Текст для Instagram / Threads — без **жирного** (там його немає); у Telegram жирний збережеться, якщо копіювати з чату
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText((cur.text ?? '').replace(/\*\*/g, ''))
      haptic('success')
      setToast('Текст скопійовано')
    } catch {
      setToast('Не вдалося скопіювати — надішли в чат і скопіюй звідти')
    }
  }

  const sendToChat = async () => {
    const r = await act('send_to_chat')
    if (!r) return
    haptic('success')
    const onPhoto = r.photo_text ? ` · на фото: «${r.photo_text}»` : ''
    setToast(r.photos ? `Надіслала в чат: текст і ${r.photos} фото${onPhoto}` : 'Надіслала текст у чат')
  }

  const sendStory = async () => {
    const r = await act('send_story', { slide_idx: slide })
    if (!r) return
    haptic('success')
    setToast(r.photos ? 'Надіслала в чат сторіз 9:16' : 'Це фото ще не готове')
  }

  const markPublished = async (action: 'publish' | 'unpublish') => {
    if (!(await act(action))) return
    haptic('success')
    setToast(action === 'publish' ? 'Позначила: викладено' : 'Повернула в календар')
    await load()
    onChanged()
  }

  const skip = async () => {
    if (!(await confirmAction('Пропустити цей пост? Він зникне з черги і календаря.'))) return
    if (!(await act('skip'))) return
    haptic('success')
    onChanged()
    onNext()
  }

  // «Пропустити і поставити готель на паузу»: пост пропускається, готель випадає з плану, його ненаписані слоти теж пропускаються
  const skipAndPause = async () => {
    const h = post.hotel
    if (!h) return
    if (!(await confirmAction(`Пропустити цей пост і поставити «${h.name}» на паузу? Агент не братиме цей готель у план, а майбутні ненаписані пости про нього пропустяться. Повернути можна у вкладці «Готелі».`))) return
    if (!(await act('skip', { reason: 'готель на паузі' }))) return
    try {
      await hotelAction('pause', h.hotel_id)
      haptic('success')
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? `Пост пропущено, але паузу не поставлено: ${e.message}` : 'Пост пропущено, але паузу не поставлено')
    }
    onChanged()
    onNext()
  }

  const toggleGolden = async () => {
    const on = !cur.is_golden
    if (!(await act('golden', { on }))) return
    haptic('success')
    setToast(on ? 'Позначила ⭐ — агент рівнятиметься на цей пост' : 'Зірку знято')
    await load()
  }

  const unapprove = async () => {
    if (!(await act('unapprove'))) return
    setToast('Повернула на перегляд')
    await load()
    onChanged()
  }

  // Фото, яке Іра зараз бачить у каруселі, і правки до нього
  const curMid = cur.media_ids?.[slide]
  const curEdit: PhotoEdit = (curMid && cur.render_params?.photo_edits?.[curMid]) || {}
  // Текст Іри з редактора на цьому фото — тоді «Текст вгору / вниз» не потрібні (текст стоїть, де вона поставила)
  const curSpec = (curMid && cur.render_params?.photo_spec?.[curMid]) || null
  const editPhoto = async (edit: { [K in keyof PhotoEdit]?: PhotoEdit[K] | null }, done: string) => {
    if (!curMid) return
    if (!(await act('photo_edit', { media_id: curMid, edit }))) return
    haptic('success')
    setToast(done)
    await load()
  }

  // Водяний знак — один на весь пост (усі фото каруселі), без агента
  const curWm: PostWm = cur.render_params?.wm ?? 'wm1'
  const setWm = async (wm: PostWm) => {
    if (wm === curWm) return
    if (!(await act('watermark', { wm }))) return
    haptic('success')
    setToast(WM_DONE[wm])
    await load()
  }

  const nextCrop = () => {
    const i = CROPS.indexOf(curEdit.crop)
    const c = CROPS[(i + 1) % CROPS.length]
    void editPhoto({ crop: c ?? null }, c ? `Кроп: ${CROP_NAME[c]}` : 'Кроп: як підібрав агент')
  }

  // «Зберегти» в редакторі: одна нова версія (той самий текст поста), агент цей слайд більше не перегенеровує; null — текст агента
  // style — обрала на обкладинці «Готель / Думка / Мінімал» (сет 6): стиль усього поста
  const saveSpec = async (spec: PhotoSpec | null, style?: StyleKey) => {
    if (!editor) return false
    const r = await act('photo_spec', { media_id: editor.mid, spec, ...(style ? { style } : {}) })
    setEditor(null)
    if (!r) return false
    haptic('success')
    setToast(spec ? 'Текст на фото збережено — малюю готовий вигляд' : 'Повернула текст агента')
    await load()
    return true
  }

  const addChip = (which: 'text' | 'photo', chip: string) => {
    haptic('select')
    const [val, set, chips, setChips] = which === 'text' ? [cText, setCText, chipsT, setChipsT] as const : [cPhoto, setCPhoto, chipsP, setChipsP] as const
    set(val ? `${val.replace(/[,\s]*$/, '')}, ${chip.toLowerCase()}` : chip)
    if (!chips.includes(chip)) setChips([...chips, chip])
  }

  const facts: [string, string][] = [
    ...(post.hotel ? [[post.hotel.name, `готель ${post.hotel.hotel_id}`] as [string, string]] : []),
    ...(post.tour ? [[`${post.tour.title}${post.tour.price_range ? ` · ${post.tour.price_range}` : ''}${post.tour.dates_example ? ` · ${post.tour.dates_example}` : ''}`, `тур ${post.tour.tour_id}`] as [string, string]] : []),
    ...(cur.key_idea ? [[cur.key_idea, 'головна думка'] as [string, string]] : []),
    ...(cur.form ? [[FORM[cur.form] ?? cur.form, 'форма поста'] as [string, string]] : []),
    ...(cur.lint?.note ? [[cur.lint.note, 'перевірка правил'] as [string, string]] : []),
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
        {total > 1 && (
          <div className="stepper">
            {order.map((oid, i) => <i key={oid} className={doneIds.has(oid) ? 'done' : i === index ? 'cur' : ''} />)}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`chip ${plat.cls}`}>{plat.name}</span>
          <span className="chip">{PILLAR[post.plan.pillar] ?? post.plan.pillar}</span>
          {approved && <span className="chip okc">{published ? 'викладено' : 'затверджено'}</span>}
          {published && post.inquiries !== undefined && <Inquiries id={post.plan.id} versionNo={post.plan.version_no} count={post.inquiries} onChanged={onChanged} />}
          {cur.version_no > 1 && <span className="chip">версія {cur.version_no}</span>}
          {!regenerating && cur.text && (
            <button className={`chip ${cur.is_golden ? 'okc' : ''}`} disabled={busy} onClick={() => void toggleGolden()}>
              {cur.is_golden ? '★ найкращий' : '☆ найкращий'}
            </button>
          )}
          {(cur.trigger === 'photo_edit' || cur.trigger === 'own_photo') && cur.prompt_version !== 'photo_look' && cur.version_no > 1 && <span className="chip">{cur.trigger === 'own_photo' ? 'твоє фото' : 'нове фото'}</span>}
        </div>
        <div className="mt-2 text-[13px]" style={{ color: 'var(--hint)' }}>
          {post.plan.scheduled_for ? new Date(post.plan.scheduled_for).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' }) : `слот: ${post.plan.day}`}
          {post.plan.slot_time ? ` · ${post.plan.slot_time.slice(0, 5)}` : ''}
        </div>
        {post.hotel && <div className="tn mt-2.5 text-[13px]">{post.hotel.name}</div>}
        {cur.key_idea && <div className="serif mt-0.5 mb-3 text-[22px] leading-[1.15]">{cur.key_idea}</div>}
        <AudienceCard plan={post.plan} />

        {regenerating ? (
          <>
            {pending.map((c) => (
              <div key={c.id}>
                <div className="text-[13px]" style={{ color: 'var(--hint)' }}>Твої правки {c.target === 'photo' ? 'до фото' : 'до тексту'}</div>
                <div className="yourc">{c.body}</div>
              </div>
            ))}
            <div className="card text-center" style={{ padding: '22px 16px' }}>
              <div className="mb-2.5 flex justify-center"><Spinner /></div>
              <b>Переробляю пост</b>
              <div className="mt-1 mb-3 text-[13px]" style={{ color: 'var(--hint)' }}>Зазвичай 1–2 хвилини. Можна закрити застосунок — напишу в чат, коли буде готово.</div>
              <div className="shimmer" style={{ width: '92%' }} /><div className="shimmer" style={{ width: '76%' }} /><div className="shimmer" style={{ width: '84%' }} />
            </div>
          </>
        ) : (
          <>
            {questions.length > 0 && view === 'new' && <DataQuestions questions={questions} busy={busy} voiceLink={post.voice_link} onSubmit={answer} />}

            {askedFor.length > 0 && view === 'new' && (
              <>
                <div className="text-[13px]" style={{ color: 'var(--hint)' }}>Ти просила</div>
                {askedFor.map((c) => <div key={c.id} className="yourc">{c.body}</div>)}
              </>
            )}

            {photoLater.length > 0 && status !== 'changes_requested' && view === 'new' && (
              <>
                <div className="text-[13px]" style={{ color: 'var(--hint)' }}>Правка до фото — зроблю вручну</div>
                {photoLater.map((c) => <div key={c.id} className="yourc">{c.body}</div>)}
              </>
            )}

            {status === 'changes_requested' && (
              <div className="card mb-3 text-[14px]" style={{ background: 'var(--warn-bg)', color: 'var(--warn)', boxShadow: 'none' }}>
                Правку збережено — нова версія з'явиться тут, щойно агент її зробить.
              </div>
            )}

            {missing.length > 0 && (
              <div className="card mb-3" style={{ background: 'var(--warn-bg)', boxShadow: 'none' }}>
                <b style={{ color: 'var(--warn)' }}>Агенту бракувало даних</b>
                <div className="mt-1 text-[14px] leading-snug">Деякі місця написані загально. Допиши в правках, що важливо — або затверди як є.</div>
              </div>
            )}

            {(shown.media_ids ?? []).length > 0 ? (
              <div className="mb-3">
                <Carousel key={shown.id} ids={shown.media_ids} media={post.media} onSlide={setSlide} start={view === 'new' ? slide : 0} ready={ready && (ready.version === shown.id || ready.key === (shown.media_ids ?? []).join(',')) ? ready.urls : undefined} />
                {rendering && shown.id === cur.id && !(ready && ready.version === cur.id) && (
                  <div className="mt-1.5 text-[13px]" style={{ color: 'var(--hint)' }}>Готую фото: рамка, обробка, текст…</div>
                )}
                {view === 'new' && !published && curMid && (
                  <>
                    <div className="qchips">
                      {curEdit.text === 'off'
                        ? <button className="on" disabled={busy} onClick={() => void editPhoto({ text: null }, 'Текст на фото повернула')}>Без тексту ✕</button>
                        : <button disabled={busy} onClick={() => void editPhoto({ text: 'off' }, 'Прибрала текст з фото')}>Без тексту</button>}
                      {!curSpec && (['top', 'bottom'] as const).map((z) => (
                        <button key={z} className={curEdit.text === z ? 'on' : ''} disabled={busy}
                          onClick={() => void editPhoto({ text: curEdit.text === z ? null : z }, curEdit.text === z ? 'Текст — де вирішив агент' : z === 'top' ? 'Текст угорі' : 'Текст унизу')}>
                          {z === 'top' ? 'Текст вгору' : 'Текст вниз'}
                        </button>
                      ))}
                      <button className={curEdit.look === 'none' ? 'on' : ''} disabled={busy}
                        onClick={() => void editPhoto({ look: curEdit.look === 'none' ? null : 'none' }, curEdit.look === 'none' ? 'Обробку повернула' : 'Без обробки — кольори як в оригіналі')}>
                        Без обробки
                      </button>
                      <button className={curEdit.crop ? 'on' : ''} disabled={busy} onClick={nextCrop}>
                        Інший кроп{curEdit.crop ? ` · ${CROP_NAME[curEdit.crop]}` : ''}
                      </button>
                      <button className={curSpec ? 'on' : ''} disabled={busy} onClick={() => { haptic('tap'); setEditor({ mid: curMid, slide }) }}>✎ Текст на фото{curSpec ? ' · твій' : ''}</button>
                    </div>
                    <div className="qchips">
                      <span className="self-center text-[13px]" style={{ color: 'var(--hint)' }}>Знак:</span>
                      {(['wm1', 'wm3', 'off'] as const).map((k) => (
                        <button key={k} className={curWm === k ? 'on' : ''} disabled={busy} onClick={() => void setWm(k)}>{WM_NAME[k]}</button>
                      ))}
                    </div>
                  </>
                )}
                {view === 'new' && !published && (
                  <div className="mt-2.5 flex gap-2">
                    {!approved && (
                      <button className="btn sec" style={{ height: 40, fontSize: 14 }} disabled={busy || uploading} onClick={() => void swapPhoto()}>
                        Інша фотка{shown.media_ids.length > 1 ? ` (${slide + 1})` : ''}
                      </button>
                    )}
                    <button className="btn sec" style={{ height: 40, fontSize: 14 }} disabled={busy || uploading || !!progress} onClick={() => fileRef.current?.click()}>
                      {progress || '+ Свої фото'}
                    </button>
                  </div>
                )}
              </div>
            ) : post.photo_need > 0 && view === 'new' ? (
              <div className="card mb-3 text-[14px] leading-snug" style={{ background: 'var(--bg2)', boxShadow: 'none' }}>
                <b>{post.hotel_photos ? 'Фото ще готуються' : 'Фото цього готелю ще немає'}</b>
                <div className="mt-1" style={{ color: 'var(--hint)' }}>
                  {post.hotel_photos
                    ? 'Агент підставить їх, щойно відкриєш пост наступного разу. Або додай своє.'
                    : 'Додай своє фото з телефону — агент сам допише до нього опис.'}
                </div>
                {!published && (
                  <button className="btn mt-3" style={{ height: 42, fontSize: 15 }} disabled={uploading || !!progress} onClick={() => fileRef.current?.click()}>
                    {progress || '+ Свої фото'}
                  </button>
                )}
              </div>
            ) : null}

            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void pickOwn(e.target.files); e.target.value = '' }} />
            {own.length > 0 && (
              <div className="card mb-3">
                <div className="mb-2 font-semibold">{own.length > 1 ? `Твої фото · ${own.length}` : 'Твоє фото'}</div>
                {own.length === 1 ? (
                  <img src={own[0].preview} alt="" className="w-full rounded" style={{ maxHeight: 320, objectFit: 'contain', background: 'var(--bg2)' }} />
                ) : (
                  <div className="grid grid-cols-3 gap-1.5">
                    {own.map((p, i) => (
                      <div key={p.preview} className="relative">
                        <img src={p.preview} alt="" className="w-full rounded" style={{ aspectRatio: '1', objectFit: 'cover', background: 'var(--bg2)' }} />
                        <button aria-label="Прибрати фото" disabled={uploading} onClick={() => dropOwn(i)} className="absolute right-1 top-1 h-6 w-6 rounded-full text-[13px]" style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
                {own.length === 1 && (shown.media_ids ?? []).length > 0 && (
                  <div className="seg mt-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <button className={ownMode === 'replace' ? 'on' : ''} onClick={() => setOwnMode('replace')}>
                      Замінити{shown.media_ids.length > 1 ? ` фото ${slide + 1}` : ''}
                    </button>
                    <button className={ownMode === 'add' ? 'on' : ''} onClick={() => setOwnMode('add')}>Додати ще одне</button>
                  </div>
                )}
                {own.length > 1 && <div className="mt-2 text-[13px]" style={{ color: 'var(--hint)' }}>Усі підуть у карусель одним оновленням. Текст на кожному фото напишеш одразу після.</div>}
                <div className="mt-3 flex gap-2">
                  <button className="btn sec" disabled={uploading} onClick={cancelOwn}>Скасувати</button>
                  <button className="btn" disabled={uploading} onClick={() => void uploadOwn()}>{uploading ? (progress || 'Завантажую…') : own.length > 1 ? `Завантажити ${own.length}` : 'Завантажити'}</button>
                </div>
              </div>
            )}

            {prev && (
              <div className="seg mb-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <button className={view === 'new' ? 'on' : ''} onClick={() => { haptic('select'); setView('new') }}>Нова (v{cur.version_no})</button>
                <button className={view === 'old' ? 'on' : ''} onClick={() => { haptic('select'); setView('old') }}>Попередня (v{prev.version_no})</button>
              </div>
            )}

            {draft !== null ? (
              <div className="card">
                <div className="mb-2 flex items-center justify-between font-semibold">Редагую сама <span className="text-[12px] font-normal" style={{ color: 'var(--hint)' }}>**так** — жирний</span></div>
                <textarea className="in" rows={Math.min(24, Math.max(10, draft.split('\n').length + Math.ceil(draft.length / 38)))} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 15, lineHeight: 1.45 }} />
                <div className="mt-3 flex gap-2">
                  <button className="btn sec" disabled={busy} onClick={() => setDraft(null)}>Скасувати</button>
                  <button className="btn" disabled={busy || !draft.trim()} onClick={() => void saveDraft()}>{busy ? 'Зберігаю…' : 'Зберегти'}</button>
                </div>
              </div>
            ) : (
            <div className="card">
              {view === 'new' && prev && (
                <label className="mb-2.5 flex items-center gap-2 text-[13px]" style={{ color: 'var(--hint)' }}>
                  <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} /> Показати, що змінилось
                </label>
              )}
              <div className="ptext">
                {view === 'new' && prev && showDiff ? renderDiff(diffWords(prev.text ?? '', shown.text ?? '')) : renderPost(shown.text ?? '')}
              </div>
              {view === 'new' && !published && (
                <button className="btn sec mt-3" style={{ height: 38, fontSize: 14 }} disabled={busy} onClick={() => { haptic('tap'); setDraft(cur.text ?? '') }}>
                  ✎ Редагувати текст самій
                </button>
              )}
            </div>
            )}

            {facts.length > 0 && (
              <details className="card facts mt-3">
                <summary><span>Що використав агент <span style={{ color: 'var(--hint)', fontWeight: 400 }}>· {facts.length}</span></span><span style={{ color: 'var(--hint)' }}>›</span></summary>
                {facts.map(([f, src]) => (
                  <div key={src} className="fact">{f}<div className="mt-0.5 text-[12px]" style={{ color: 'var(--hint)' }}>{src}</div></div>
                ))}
              </details>
            )}

            {approved && view === 'new' && (
              <div className="card mt-3">
                <b>{published ? 'Викладено' : 'Готово до публікації'}</b>
                <div className="mt-1 mb-3 text-[13px] leading-snug" style={{ color: 'var(--hint)' }}>
                  {(cur.media_ids ?? []).length
                    ? `Надішлю в чат текст і фото файлами — з білою рамкою${post.plan.platform === 'telegram' ? '' : ', під формат 4:5'}. Звідти зберігаєш у галерею і публікуєш.`
                    : 'Надішлю текст у чат — звідти копіюєш і публікуєш.'}
                </div>
                <div className="flex gap-2">
                  <button className="btn sec" style={{ height: 42, fontSize: 14 }} onClick={() => void copyText()}>Копіювати текст</button>
                  <button className="btn" style={{ height: 42, fontSize: 14 }} disabled={busy} onClick={() => void sendToChat()}>{busy ? 'Готую…' : 'Надіслати в чат'}</button>
                </div>
                {(cur.media_ids ?? []).length > 0 && (
                  <button className="btn sec mt-2" style={{ height: 40, fontSize: 14 }} disabled={busy} onClick={() => void sendStory()}>
                    Сторіз 9:16 у чат{(cur.media_ids ?? []).length > 1 ? ` · фото ${slide + 1}` : ''}
                  </button>
                )}
                {!published && (
                  <button className="btn sec mt-2" style={{ height: 40, fontSize: 14 }} disabled={busy} onClick={() => void markPublished('publish')}>Виклала — позначити опублікованим</button>
                )}
              </div>
            )}

            {!approved && view === 'new' && (
              <>
                <Label>Правки</Label>
                <div className="card">
                  <div className="mb-2 flex items-center justify-between font-semibold">До тексту <span className="text-[13px] font-normal" style={{ color: 'var(--hint)' }}>необов'язково</span></div>
                  <textarea className="in" rows={2} value={cText} placeholder="Напр.: коротше, без слова «розкішний»" onChange={(e) => setCText(e.target.value)} />
                  <div className="qchips">{CHIPS_TEXT.map((c) => <button key={c} onClick={() => addChip('text', c)}>{c}</button>)}</div>
                </div>
                <div className="card mt-3">
                  <div className="mb-2 flex items-center justify-between font-semibold">До фото <span className="text-[13px] font-normal" style={{ color: 'var(--hint)' }}>необов'язково</span></div>
                  <textarea className="in" rows={2} value={cPhoto} placeholder="Напр.: прибери текст, без обробки" onChange={(e) => setCPhoto(e.target.value)} />
                  <div className="qchips">{CHIPS_PHOTO.map((c) => <button key={c} onClick={() => addChip('photo', c)}>{c}</button>)}</div>
                </div>
                <div className="mx-2 mt-3 text-center text-[13px]" style={{ color: 'var(--hint)' }}>«До тексту» не чіпає фото, «До фото» не чіпає текст.</div>
                <div className="mx-2 mt-1 text-center text-[13px]" style={{ color: 'var(--hint)' }}>Затверджений пост іде в календар. Передумаєш — його можна повернути.</div>
                <button className="mx-auto mt-4 block text-[14px]" style={{ color: 'var(--hint)' }} disabled={busy} onClick={() => void skip()}>Пропустити цей пост</button>
                {post.hotel && <button className="mx-auto mt-2 block text-[14px]" style={{ color: 'var(--hint)' }} disabled={busy} onClick={() => void skipAndPause()}>…і поставити «{post.hotel.name}» на паузу</button>}
              </>
            )}
          </>
        )}
      </div>

      <div className="bbar">
        {regenerating ? (
          <button className="btn" onClick={onNext}>{total > 1 ? 'Далі, поки чекаю' : 'На головну'}</button>
        ) : approved ? (
          <>
            {published
              ? <button className="btn sec" disabled={busy} onClick={() => void markPublished('unpublish')}>Ще не викладено</button>
              : <button className="btn sec" disabled={busy} onClick={() => void unapprove()}>Повернути на перегляд</button>}
            <button className="btn" onClick={onNext}>Далі</button>
          </>
        ) : view === 'old' && prev ? (
          <>
            <button className="btn sec" onClick={() => setView('new')}>До нової</button>
            <button className="btn" disabled={busy} onClick={() => void restore()}>Повернути цю версію</button>
          </>
        ) : hasComment ? (
          <>
            <button className="btn sec" disabled={busy} onClick={() => { setCText(''); setCPhoto(''); setChipsT([]); setChipsP([]) }}>Скинути</button>
            <button className="btn" disabled={busy} onClick={() => void redo()}>{busy ? 'Надсилаю…' : 'Переробити'}</button>
          </>
        ) : (
          <>
            <button className="btn sec" onClick={onNext}>Пізніше</button>
            <button className="btn" disabled={busy || draft !== null} onClick={() => void approve()}>{busy ? '…' : 'Затвердити'}</button>
          </>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
      {editor && (
        <PhotoEditor planId={post.plan.id} mediaId={editor.mid} slide={editor.slide} photos={(cur.media_ids ?? []).length} busy={busy}
          onClose={() => setEditor(null)} onSave={saveSpec} />
      )}
    </div>
  )
}

// Пост ще без тексту: питання агента (needs_data), «дописую» (після відповідей) або «ще готується»
function NoTextYet({ post, plat, questions, busy, toast, total, onAnswer, onNext }: {
  post: PostDetail; plat: { name: string; cls: string }; questions: NonNullable<PostDetail['questions']>; busy: boolean; toast: string; total: number
  onAnswer: (answers: { id: string; answer: string }[]) => Promise<boolean>; onNext: () => void
}) {
  const status = post.plan.review_status
  const working = status === 'regenerating' || status === 'generating'
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`chip ${plat.cls}`}>{plat.name}</span>
          <span className="chip">{PILLAR[post.plan.pillar] ?? post.plan.pillar}</span>
        </div>
        <div className="mt-2 text-[13px]" style={{ color: 'var(--hint)' }}>
          {post.plan.scheduled_for ? new Date(post.plan.scheduled_for).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' }) : `слот: ${post.plan.day}`}
          {post.plan.slot_time ? ` · ${post.plan.slot_time.slice(0, 5)}` : ''}
        </div>
        {(post.hotel || post.tour) && <div className="serif mt-1 mb-3 text-[22px] leading-[1.15]">{post.hotel?.name ?? post.tour?.title}</div>}
        {working ? (
          <div className="card text-center" style={{ padding: '22px 16px' }}>
            <div className="mb-2.5 flex justify-center"><Spinner /></div>
            <b>Дописую пост</b>
            <div className="mt-1 mb-3 text-[13px]" style={{ color: 'var(--hint)' }}>Зазвичай 1–2 хвилини. Можна закрити застосунок — напишу в чат, коли буде готово.</div>
            <div className="shimmer" style={{ width: '92%' }} /><div className="shimmer" style={{ width: '76%' }} /><div className="shimmer" style={{ width: '84%' }} />
          </div>
        ) : questions.length > 0 ? (
          <DataQuestions questions={questions} busy={busy} voiceLink={post.voice_link} onSubmit={onAnswer} />
        ) : (
          <div className="card text-center">
            <b>{status === 'needs_data' ? 'Відповіді збережено' : 'Пост ще готується'}</b>
            <div className="mt-1 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
              {status === 'needs_data' ? 'Пост допишу трохи згодом і напишу в чат.' : 'Агент напише його сам і покаже тут.'}
            </div>
          </div>
        )}
      </div>
      <div className="bbar">
        <button className="btn sec" onClick={onNext}>{total > 1 ? (working ? 'Далі, поки чекаю' : 'Пізніше') : 'На головну'}</button>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, getPost, reviewAction, type PostDetail, type Version } from '../lib/api'
import { preparePhoto, putToSignedUrl, type PreparedPhoto } from '../lib/image'
import { diffWords, renderDiff, renderPost } from '../lib/text'
import { haptic, isDemo, useBackButton } from '../lib/tg'
import { Carousel } from './Carousel'
import { Center, Label, Spinner } from './ui'

export const PLATFORM: Record<string, { name: string; cls: string }> = {
  telegram: { name: 'Telegram', cls: 'tg' },
  instagram: { name: 'Instagram', cls: 'ig' },
  threads: { name: 'Threads', cls: 'th' },
}

export const PILLAR: Record<string, string> = {
  tour_offer: 'тур-пропозиція', tour_offer_fallback: 'тур', tour_offer_seasonal: 'сезонний тур', tour_expert: 'експертна думка',
  hotel_place: 'про готель', insider: 'інсайдер', atmosphere: 'атмосфера', personal: 'особисте', personal_take: 'думка',
  behind_scenes: 'закулісся', video: 'відео', template: 'шаблон', unusual_hotels: 'незвичайні готелі',
}

const FORM: Record<string, string> = { one_fact: 'один факт', list: 'перелік', story: 'історія', question: 'питання', comparison: 'порівняння' }

const CHIPS_TEXT = ['Коротше', 'Тепліше, більше мене', 'Без ціни', 'Інший початок', 'Більше фактів']
// «Інша фотка» — окрема кнопка під фото (міняє одразу), тут лише те, що чекає обробки (фаза 6c)
const CHIPS_PHOTO = ['Обробка не та', 'Без напису', 'Світліше', 'Інший ракурс']

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
  const [own, setOwn] = useState<PreparedPhoto | null>(null)
  const [ownMode, setOwnMode] = useState<'replace' | 'add'>('add')
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)

  useBackButton(true, onBack)

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

  if (error && !post) return <Center><p style={{ color: 'var(--hint)' }}>Не вдалося завантажити пост. {error}</p><button className="btn sec mt-4" onClick={() => void load()}>Спробувати ще</button></Center>
  if (!post || !cur) return <Center><Spinner /></Center>

  const plat = PLATFORM[post.plan.platform] ?? { name: post.plan.platform, cls: '' }
  const status = post.plan.review_status
  const approved = status === 'approved'
  const shown: Version = view === 'old' && prev ? prev : cur
  const hasComment = Boolean(cText.trim() || cPhoto.trim())
  const missing = (cur.missing_facts ?? []).filter((m) => m && (m.note || m.field))

  const act = async (action: 'approve' | 'unapprove' | 'comment' | 'restore' | 'swap_photo' | 'upload_url' | 'add_photo' | 'send_to_chat' | 'edit_text', extra = {}) => {
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

  const approve = async () => {
    if (!(await act('approve'))) return
    haptic('success')
    setToast(`Затверджено · ${plat.name}`)
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

  const pickOwn = async (file: File | undefined) => {
    if (!file) return
    try {
      const prepared = await preparePhoto(file)
      setOwn(prepared)
      setOwnMode((shown.media_ids ?? []).length ? 'replace' : 'add')
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Не вдалося відкрити фото')
    }
  }

  const cancelOwn = () => {
    if (own) URL.revokeObjectURL(own.preview)
    setOwn(null)
  }

  // Своє фото: підписане посилання → файл прямо в Storage → новий рядок media + версія поста
  const uploadOwn = async () => {
    if (!own) return
    setUploading(true)
    try {
      const u = await reviewAction(post.plan.id, post.plan.version_no, 'upload_url')
      if (!isDemo) await putToSignedUrl(u.signed_url ?? '', own.blob)
      const r = await act('add_photo', { path: u.path, mode: ownMode, slide_idx: slide, width: own.width, height: own.height, preview: own.preview })
      if (!r) return
      haptic('success')
      setToast('Фото додано — опис агент допише сам')
      setOwn(null)
      await load()
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : 'Фото не завантажилось')
    } finally {
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
    setToast(r.photos ? `Надіслала в чат: текст і ${r.photos} фото` : 'Надіслала текст у чат')
  }

  const unapprove = async () => {
    if (!(await act('unapprove'))) return
    setToast('Повернула на перегляд')
    await load()
    onChanged()
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
          {approved && <span className="chip okc">затверджено</span>}
          {cur.version_no > 1 && <span className="chip">версія {cur.version_no}</span>}
          {(cur.trigger === 'photo_edit' || cur.trigger === 'own_photo') && cur.version_no > 1 && <span className="chip">{cur.trigger === 'own_photo' ? 'твоє фото' : 'нове фото'}</span>}
        </div>
        <div className="mt-2 text-[13px]" style={{ color: 'var(--hint)' }}>
          {post.plan.scheduled_for ? new Date(post.plan.scheduled_for).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' }) : `слот: ${post.plan.day}`}
          {post.plan.slot_time ? ` · ${post.plan.slot_time.slice(0, 5)}` : ''}
        </div>
        {post.hotel && <div className="tn mt-2.5 text-[13px]">{post.hotel.name}</div>}
        {cur.key_idea && <div className="serif mt-0.5 mb-3 text-[22px] leading-[1.15]">{cur.key_idea}</div>}

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
            {askedFor.length > 0 && view === 'new' && (
              <>
                <div className="text-[13px]" style={{ color: 'var(--hint)' }}>Ти просила</div>
                {askedFor.map((c) => <div key={c.id} className="yourc">{c.body}</div>)}
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
                <Carousel key={shown.id} ids={shown.media_ids} media={post.media} onSlide={setSlide} start={view === 'new' ? slide : 0} />
                {view === 'new' && !approved && (
                  <div className="mt-2.5 flex gap-2">
                    <button className="btn sec" style={{ height: 40, fontSize: 14 }} disabled={busy || uploading} onClick={() => void swapPhoto()}>
                      Інша фотка{shown.media_ids.length > 1 ? ` (${slide + 1})` : ''}
                    </button>
                    <button className="btn sec" style={{ height: 40, fontSize: 14 }} disabled={busy || uploading} onClick={() => fileRef.current?.click()}>
                      + Своє фото
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
                {!approved && (
                  <button className="btn mt-3" style={{ height: 42, fontSize: 15 }} disabled={uploading} onClick={() => fileRef.current?.click()}>
                    + Своє фото
                  </button>
                )}
              </div>
            ) : null}

            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void pickOwn(e.target.files?.[0]); e.target.value = '' }} />
            {own && (
              <div className="card mb-3">
                <div className="mb-2 font-semibold">Твоє фото</div>
                <img src={own.preview} alt="" className="w-full rounded" style={{ maxHeight: 320, objectFit: 'contain', background: 'var(--bg2)' }} />
                {(shown.media_ids ?? []).length > 0 && (
                  <div className="seg mt-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <button className={ownMode === 'replace' ? 'on' : ''} onClick={() => setOwnMode('replace')}>
                      Замінити{shown.media_ids.length > 1 ? ` фото ${slide + 1}` : ''}
                    </button>
                    <button className={ownMode === 'add' ? 'on' : ''} onClick={() => setOwnMode('add')}>Додати ще одне</button>
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <button className="btn sec" disabled={uploading} onClick={cancelOwn}>Скасувати</button>
                  <button className="btn" disabled={uploading} onClick={() => void uploadOwn()}>{uploading ? 'Завантажую…' : 'Завантажити'}</button>
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
              {view === 'new' && (
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
                <b>Готово до публікації</b>
                <div className="mt-1 mb-3 text-[13px] leading-snug" style={{ color: 'var(--hint)' }}>
                  {(cur.media_ids ?? []).length
                    ? `Надішлю в чат текст і фото файлами — з білою рамкою${post.plan.platform === 'telegram' ? '' : ', під формат 4:5'}. Звідти зберігаєш у галерею і публікуєш.`
                    : 'Надішлю текст у чат — звідти копіюєш і публікуєш.'}
                </div>
                <div className="flex gap-2">
                  <button className="btn sec" style={{ height: 42, fontSize: 14 }} onClick={() => void copyText()}>Копіювати текст</button>
                  <button className="btn" style={{ height: 42, fontSize: 14 }} disabled={busy} onClick={() => void sendToChat()}>{busy ? 'Готую…' : 'Надіслати в чат'}</button>
                </div>
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
                  <div className="mb-2 flex items-center justify-between font-semibold">До фото <span className="text-[13px] font-normal" style={{ color: 'var(--hint)' }}>фото з'являться згодом</span></div>
                  <textarea className="in" rows={2} value={cPhoto} placeholder="Напр.: світліше, без напису на фото" onChange={(e) => setCPhoto(e.target.value)} />
                  <div className="qchips">{CHIPS_PHOTO.map((c) => <button key={c} onClick={() => addChip('photo', c)}>{c}</button>)}</div>
                </div>
                <div className="mx-2 mt-3 text-center text-[13px]" style={{ color: 'var(--hint)' }}>Затверджений пост іде в календар. Передумаєш — його можна повернути.</div>
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
            <button className="btn sec" disabled={busy} onClick={() => void unapprove()}>Повернути на перегляд</button>
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
    </div>
  )
}

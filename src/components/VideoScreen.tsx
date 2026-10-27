import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { ackRemount, getVideo, markVideoPosted, remountVideo, resendVideo, saveVideoCaption, videoAction, type VideoAction } from '../lib/api'
import { confirmAction, haptic, isDemo, openTelegram, useBackButton } from '../lib/tg'
import {
  FONT, GOLD, MOOD, SAFE_BOTTOM, SAFE_TOP, STYLES, VH, VW, WM, lineGap, newId, planOf, pubState, remounting, slotLabel, textTimes, wmBox, words,
  type LineStyle, type RemountJob, type RemountKind, type VideoDraft, type VLine, type VText, type WmKind, type WmPos,
} from '../lib/video'
import { Center, Spinner } from './ui'

const FADE = 0.45
const SUB_FADE = 0.12 // субтитри голосу — як SUB_FADE у server/video_layers.ts
const POS: { name: string; y: number }[] = [{ name: 'Вгорі', y: 330 }, { name: 'Центр', y: 820 }, { name: 'Внизу', y: 1150 }]
const SCRIM: { name: string; a: number }[] = [{ name: 'Без', a: 0 }, { name: 'Легке', a: 0.28 }, { name: 'Сильне', a: 0.5 }]
const WM_POS: { id: WmPos; name: string }[] = [{ id: 'tl', name: '↖ ліворуч вгорі' }, { id: 'tr', name: '↗ праворуч вгорі' }, { id: 'bl', name: '↙ ліворуч унизу' }, { id: 'br', name: '↘ праворуч унизу' }]
const FORMAT = { stories: 'Сторіз', reel: 'Рілс' }

type Tab = 'text' | 'wm' | 'shots'

// Редактор сторіз/рілсу: відео + живі шари тексту і знака. Дані — /api/video (у демо — lib/video)
export function VideoScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const [draft, setDraft] = useState<VideoDraft | null>(null)
  const [error, setError] = useState('')

  useBackButton(true, onBack)

  useEffect(() => {
    getVideo(id).then(setDraft).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [id])

  if (error) {
    return (
      <Center>
        <p className="text-[15px] leading-snug" style={{ color: 'var(--hint)' }}>Не вдалося відкрити відео. {error}</p>
        <button className="btn sec mt-3" onClick={onBack}>Назад</button>
      </Center>
    )
  }
  if (!draft) return <Center><Spinner /></Center>
  return <Editor initial={draft} onBack={onBack} />
}

const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '')

function Editor({ initial, onBack }: { initial: VideoDraft; onBack: () => void }) {
  const [d, setD] = useState<VideoDraft>(initial)
  // «Незбережене» — лише план (тексти / знак / обкладинка); статус і готове відео приходять з сервера окремо
  const [saved, setSaved] = useState(() => JSON.stringify(planOf(initial)))
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('text')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [toast, setToast] = useState('')
  // звук (музика / голос) — лише після дотику: мобільний браузер грає відео зі звуком тільки за жестом
  const [muted, setMuted] = useState(true)
  // підпис до поста (SQL 022) — зберігається окремо від плану, готове відео не скидає
  const [cap, setCap] = useState(initial.caption ?? '')
  const [capSaved, setCapSaved] = useState(initial.caption ?? '')
  const vref = useRef<HTMLVideoElement>(null)
  const dirty = JSON.stringify(planOf(d)) !== saved
  const montage = d.status === 'approved' && !d.final
  // перемонтаж кадрів (воркер, 30–90 с): поки йде — текст не правиться, бо воркер сам переназначить кадри текстів
  const locked = remounting(d)
  // уже вийшло (канал або «✅ Виклала») — лише перегляд
  const published = Boolean(d.published_at)
  const hasCaption = d.format === 'reel' || d.platform === 'telegram'
  const waitPublish = d.status === 'approved' && Boolean(d.final) && !published

  // Готове й чекає слоту / надіслане в чат — раз на 30 с: чи вже надіслано, чи Іра натиснула «✅ Виклала» в боті
  useEffect(() => {
    if (!waitPublish) return
    const x = setInterval(() => {
      getVideo(d.id).then((v) => setD((cur) => ({ ...cur, final: v.final, delivered_at: v.delivered_at, published_at: v.published_at }))).catch(() => null)
    }, 30000)
    return () => clearInterval(x)
  }, [waitPublish, d.id])

  // Затверджено, а готового ще нема — воркер монтує (1–2 хв): раз на 15 с питаємо, чи готове
  useEffect(() => {
    if (!montage || d.render_error) return
    const x = setInterval(() => {
      getVideo(d.id).then((v) => { if (v.final) setD((cur) => ({ ...cur, final: v.final, render_error: v.render_error })) }).catch(() => null)
    }, 15000)
    return () => clearInterval(x)
  }, [montage, d.id, d.render_error])

  // Перемонтовую — раз на 5 с питаємо, чи готово; готово → нове відео, кадри й тексти (з переназначеними кадрами)
  useEffect(() => {
    if (!locked) return
    const x = setInterval(() => {
      getVideo(d.id).then((v) => {
        if (remounting(v)) return
        setD(v)
        setSaved(JSON.stringify(planOf(v)))
        setSel(null)
        haptic(v.remount?.state === 'error' ? 'error' : 'success')
      }).catch(() => null)
    }, 5000)
    return () => clearInterval(x)
  }, [locked, d.id])

  // Іра повернулась з бота (надіслала голосове) — бот уже поставив заявку: підтягуємо стан, щоб побачила «Монтую голос…»
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible' || dirty || locked) return
      getVideo(d.id).then((v) => {
        if (v.updated_at === d.updated_at && !remounting(v)) return
        setD(v)
        setSaved(JSON.stringify(planOf(v)))
        setSel(null)
      }).catch(() => null)
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [d.id, d.updated_at, dirty, locked])

  useEffect(() => { if (vref.current) vref.current.muted = muted }, [muted])

  useEffect(() => {
    if (!toast) return
    const x = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(x)
  }, [toast])

  // Час відео → які тексти видно (rAF, щоб поява/зникнення були плавні)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = vref.current
      if (v) setT(v.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seek = (s: number, pause = true) => {
    const v = vref.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(d.dur - 0.05, s))
    if (pause) { v.pause(); setPlaying(false) }
  }
  const togglePlay = () => {
    const v = vref.current
    if (!v) return
    if (v.paused) { setSel(null); void v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) }
  }

  // Вибрала текст — ставимо відео на його кадр і паузу, щоб бачити, що редагуєш
  const select = (tid: string | null) => {
    if (locked && tid) { setToast('Перемонтовую кадри — текст зміниш за хвилинку'); return }
    setSel(tid)
    const tx = d.texts.find((x) => x.id === tid)
    if (tx) {
      const { t0, t1 } = textTimes(d, tx)
      seek(Math.min(t0 + 0.8, (t0 + t1) / 2))
      setTab('text')
    }
  }

  const upd = (fn: (x: VideoDraft) => void) => setD((cur) => { if (remounting(cur)) return cur; const n = structuredClone(cur); fn(n); return n })
  const updText = (tid: string, fn: (x: VText) => void) => upd((n) => { const x = n.texts.find((q) => q.id === tid); if (x) fn(x) })

  const curText = d.texts.find((x) => x.id === sel)

  const addText = () => {
    const shotNow = Math.max(0, d.shots.findIndex((s) => t >= s.t0 && t < s.t1))
    const tx: VText = { id: newId(), from: shotNow, to: shotNow, y: 820, scrim: 0.28, lines: [{ text: 'Новий текст', style: 'hook', gold: [] }] }
    upd((n) => { n.texts.push(tx) })
    haptic('tap')
    setTimeout(() => select(tx.id), 0)
  }

  const removeText = async (tid: string) => {
    if (!(await confirmAction('Прибрати цей текст з відео?'))) return
    upd((n) => { n.texts = n.texts.filter((x) => x.id !== tid) })
    setSel(null)
  }

  // Правки й статус — через /api/video; відповідь дає новий updated_at (щоб наступне «Зберегти» не впало в 409)
  const act = async (action: VideoAction, msg: string) => {
    if (busy) return false
    setBusy(true)
    try {
      const r = await videoAction(d, action, action === 'save' || action === 'approve' ? planOf(d) : undefined)
      // будь-яка правка / зміна статусу (крім «не публікувати») — старе готове відео вже не те, воркер змонтує нове
      const n = { ...d, status: r.status, updated_at: r.updated_at, ...(action === 'skip' ? {} : { final: null, render_error: null, delivered_at: null }) }
      setD(n)
      setSaved(JSON.stringify(planOf(n)))
      haptic('success')
      setToast(msg)
      return true
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveCap = async () => {
    if (busy) return false
    setBusy(true)
    try {
      const r = await saveVideoCaption(d.id, cap)
      setCap(r.caption)
      setCapSaved(r.caption)
      haptic('success')
      setToast('Підпис збережено')
      return true
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Затвердити разом з незбереженим підписом — щоб у слот пішов саме він
  const approve = async () => {
    if (cap !== capSaved && !(await saveCap())) return
    await act('approve', d.scheduled_for ? `Затверджено ✓ Відео змонтую, а ${slotLabel(d.scheduled_for).date} о ${slotLabel(d.scheduled_for).time} ${d.dest === 'channel' ? 'викладу в канал' : 'надішлю в чат'}` : 'Затверджено ✓ Готове відео з цим текстом прийде в чат')
  }

  const posted = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await markVideoPosted(d.id)
      setD((cur) => ({ ...cur, published_at: r.published_at }))
      haptic('success')
      setToast('Позначила: опубліковано ✓')
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const skip = async () => {
    if (!(await confirmAction('Не публікувати це відео? Воно зникне зі «Сьогодні».'))) return
    if (await act('skip', 'Добре, це відео не публікуємо')) onBack()
  }

  const resend = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await resendVideo(d.id)
      setD((cur) => ({ ...cur, final: cur.final ? { ...cur.final, sent_at: r.sent_at } : cur.final }))
      haptic('success')
      setToast('Надіслала в чат ✓')
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Кадри: заявка воркеру. Незбережений текст спершу зберігаємо — інакше він би загубився
  const remount = async (job: RemountJob, question: string) => {
    if (busy || locked) return
    const again = d.status === 'approved' ? '\n\nЗатвердження скинеться — після перемонтажу затвердиш ще раз.' : ''
    if (!(await confirmAction(`${question}\n\nПеремонтую відео — це 30–90 с. Тексти лишаться.${again}`))) return
    if (dirty && !(await act('save', 'Збережено'))) return
    setBusy(true)
    try {
      const r = await remountVideo(d, job)
      setD((cur) => ({ ...cur, status: r.status, updated_at: r.updated_at, final: null, render_error: null, remount: { state: 'queued', kind: job.kind, note: [], error: null } }))
      setSel(null)
      haptic('success')
      return true
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const ack = () => {
    void ackRemount(d.id).catch(() => null)
    setD((cur) => ({ ...cur, remount: null }))
  }

  const reset = () => { setD((cur) => ({ ...cur, ...(JSON.parse(saved) as ReturnType<typeof planOf>) })); setSel(null) }
  // «🎙 Озвучити голосом» — у бот: він попросить голосове саме до цього відео, далі воркер змонтує (WF-055 → remount voice)
  const voice = () => {
    if (!d.voice_link) { haptic('warning'); setToast('Голос через бот ще не ввімкнено — скажи Владу'); return }
    haptic('tap')
    openTelegram(d.voice_link)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`chip ${d.platform === 'instagram' ? 'ig' : 'tg'}`}>{d.platform === 'instagram' ? 'Instagram' : 'Telegram'}</span>
          <span className="chip">{FORMAT[d.format]}</span>
          <span className="chip">{d.place}</span>
          {published ? <span className="chip okc">опубліковано ✓</span> : d.status === 'approved' && <span className="chip okc">{d.final ? 'готово ✓' : 'затверджено'}</span>}
          {isDemo && <span className="chip warn">демо</span>}
        </div>
        <div className="serif mt-2 mb-3 text-[22px] leading-[1.15]">{d.name}</div>

        {d.remount && <RemountCard r={d.remount} onOk={ack} />}

        {(d.status === 'approved' || published) && !dirty && <PublishCard d={d} busy={busy} onResend={() => void resend()} onPosted={() => void posted()} />}

        {/* Поки редагує текст — відео менше і «прилипає» вгорі, щоб правки було видно під час набору.
            Без вибраного тексту не прилипає: велике прев'ю на низькому екрані ховало вкладки «Текст / Знак / Кадри» */}
        <div className={`${sel !== null ? 'sticky' : 'relative'} z-10 -mx-4 px-4 pt-3 pb-2`} style={{ top: -12, background: 'var(--bg)' }}>
          <Preview d={d} t={t} sel={sel} small={sel !== null} vref={vref} onSelect={select} onMove={(tid, y) => updText(tid, (x) => { x.y = y })} onTap={togglePlay} />
          <Timeline d={d} t={t} playing={playing} small={sel !== null} onPlay={togglePlay} onSeek={(s) => seek(s)}
            muted={d.music || d.voice ? muted : null} onSound={() => { haptic('select'); setMuted((m) => !m) }} />
          {sel === null && (
            <div className="mt-1.5 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>
              Торкнись тексту на відео, щоб змінити. Потягни — щоб посунути.
            </div>
          )}
        </div>

        <div className="seg mt-4" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          {(['text', 'wm', 'shots'] as Tab[]).map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => { haptic('select'); setTab(k); if (k !== 'text') setSel(null) }}>
              {k === 'text' ? 'Текст' : k === 'wm' ? 'Знак' : 'Кадри'}
            </button>
          ))}
        </div>

        {tab === 'text' && (
          <>
            <div className="qchips">
              {d.texts.map((x, i) => (
                <button key={x.id} className={x.id === sel ? 'on' : ''} onClick={() => select(x.id === sel ? null : x.id)}>
                  {x.sec ? '💬' : i + 1} · {short(x.lines[0]?.text ?? '')}
                </button>
              ))}
              <button onClick={addText}>＋ Додати текст</button>
            </div>
            {locked ? (
              <div className="card mt-3 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
                Поки перемонтовую кадри, текст не змінюється — це 30–90 с. Потім тексти будуть на своїх кадрах.
              </div>
            ) : curText ? (
              <TextEditor d={d} x={curText} onChange={(fn) => updText(curText.id, fn)} onRemove={() => void removeText(curText.id)} />
            ) : (
              <div className="card mt-3 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
                Обери текст угорі або торкнись його на відео. Тут можна змінити слова, шрифт, золото, місце, на яких кадрах видно.
              </div>
            )}
          </>
        )}

        {tab === 'wm' && <WmEditor d={d} onChange={upd} />}

        {tab === 'shots' && (
          <>
            <ShotsEditor d={d} t={t} disabled={busy || locked} onSeek={(s) => seek(s)} onRemount={remount} />
            <SoundCard d={d} disabled={busy || locked} onRemount={remount} onVoice={voice} />
            <div className="card mt-3">
              <div className="flex items-center gap-3">
                <img src={d.poster} alt="" className="rounded-md object-cover" style={{ width: 54, height: 96 }} />
                <div className="min-w-0 flex-1">
                  <b className="block text-[14.5px]">Обкладинка</b>
                  <span className="text-[13px]" style={{ color: 'var(--hint)' }}>кадр на {d.cover.toFixed(1)} с</span>
                </div>
              </div>
              <button className="btn sec mt-3" onClick={() => { upd((n) => { n.cover = Math.round(t * 10) / 10 }); setToast(`Обкладинка — кадр на ${t.toFixed(1)} с`) }}>
                Зробити обкладинкою цей кадр
              </button>
            </div>
          </>
        )}

        {hasCaption && (
          <div className="card mt-3">
            <b className="block text-[14.5px]">Підпис до поста</b>
            <span className="text-[13px]" style={{ color: 'var(--hint)' }}>
              {d.dest === 'channel' ? 'піде в канал разом з відео' : 'бот надішле його з відео — скопіюєш в Instagram'}
            </span>
            <textarea className="in mt-2" rows={5} value={cap} disabled={published} maxLength={2200}
              placeholder={published ? '' : 'Агент ще не написав підпис — можна свій'} onChange={(e) => setCap(e.target.value)} />
            {cap !== capSaved && !published && (
              <div className="mt-2 flex gap-2">
                <button className="btn sec" onClick={() => setCap(capSaved)}>Скинути</button>
                <button className="btn" disabled={busy} onClick={() => void saveCap()}>Зберегти підпис</button>
              </div>
            )}
          </div>
        )}

        {d.status !== 'approved' && !published && (
          <button className="mt-6 block w-full text-center text-[14px]" style={{ color: 'var(--bad)' }} onClick={() => void skip()}>Не публікувати це відео</button>
        )}
      </div>

      <div className="bbar">
        {published ? (
          <button className="btn sec" onClick={onBack}>Назад</button>
        ) : locked ? (
          <>
            <button className="btn sec" onClick={onBack}>Пізніше</button>
            <button className="btn" disabled>Перемонтовую…</button>
          </>
        ) : dirty ? (
          <>
            <button className="btn sec" onClick={reset}>Скинути</button>
            <button className="btn" disabled={busy} onClick={() => void act('save', 'Збережено')}>{busy ? 'Зберігаю…' : 'Зберегти'}</button>
          </>
        ) : d.status === 'approved' ? (
          <>
            <button className="btn sec" disabled={busy} onClick={() => void act('unapprove', 'Повернула на перегляд')}>Повернути на перегляд</button>
            <button className="btn" onClick={onBack}>Далі</button>
          </>
        ) : (
          <>
            <button className="btn sec" onClick={onBack}>Пізніше</button>
            <button className="btn" disabled={busy} onClick={() => void approve()}>Затвердити</button>
          </>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

// ───────────── Публікація (сет 7): чекає слоту / надіслано в чат / опубліковано ─────────────

function PublishCard({ d, busy, onResend, onPosted }: { d: VideoDraft; busy: boolean; onResend: () => void; onPosted: () => void }) {
  const s = pubState({ ...d, ready: Boolean(d.final) })
  const slot = d.scheduled_for ? slotLabel(d.scheduled_for) : null
  const where = d.platform === 'telegram' ? (d.dest === 'channel' ? 'Telegram-каналі' : 'Telegram') : 'Instagram'
  const reel = d.format === 'reel'
  const btn = { width: 'auto', paddingInline: 14 }
  const Row = ({ posted = false, resend = 'Надіслати ще раз' }: { posted?: boolean; resend?: string }) => (
    <div className="mt-3 flex gap-2">
      {posted && <button className="btn" disabled={busy} onClick={onPosted}>✅ Виклала</button>}
      <button className="btn sec" style={posted ? undefined : btn} disabled={busy} onClick={onResend}>{resend}</button>
    </div>
  )

  if (s === 'rendering') {
    return d.render_error ? (
      <div className="card mb-3 text-[13.5px] leading-snug">
        <b className="block text-[14.5px]">Не вдалося змонтувати</b>
        <span style={{ color: 'var(--hint)' }}>Влад уже бачить помилку. Можна «Повернути на перегляд» і затвердити ще раз.</span>
      </div>
    ) : (
      <div className="card mb-3 flex items-center gap-3">
        <div className="shrink-0"><Spinner /></div>
        <div className="text-[13.5px] leading-snug">
          <b className="block text-[14.5px]">Монтую готове відео…</b>
          <span style={{ color: 'var(--hint)' }}>з цим текстом і знаком — прийде в чат за 1–2 хв</span>
        </div>
      </div>
    )
  }
  let title = '', sub = '', row: ReactNode = null
  if (s === 'published') {
    title = 'Опубліковано ✓'
    sub = d.dest === 'channel' && !d.delivered_at ? `у Telegram-каналі о ${hhmm(d.published_at)}` : `в ${where} · позначено о ${hhmm(d.published_at)}`
  } else if (s === 'delivered') {
    title = `Надіслано тобі в чат о ${hhmm(d.delivered_at)}`
    sub = `У чаті з ботом: відео${d.nomusic ? ' з музикою і без' : ''}${reel ? ', обкладинка' : ''}${d.caption ? ' і підпис' : ''}. Виклади в ${where} і натисни «✅ Виклала».`
    row = <Row posted />
  } else if (s === 'waiting' && slot) {
    title = `Готове ✓ · чекає слоту ${slot.date} о ${slot.time}`
    sub = d.dest === 'channel'
      ? 'Бот сам викладе відео в канал з підписом.'
      : `О ${slot.time} бот надішле тобі в чат відео${d.nomusic ? ' (з музикою і без)' : ''}${reel ? ', обкладинку' : ''} і підпис — лишиться викласти.`
    sub += ' Скасувати — «Повернути на перегляд».'
    row = <Row resend="Переглянути в чаті" />
  } else if (s === 'sending') {
    title = d.dest === 'channel' ? 'Слот настав — викладаю в канал…' : 'Слот настав — надсилаю тобі в чат…'
    sub = 'За кілька хвилин.'
  } else {
    title = 'Готове відео в чаті ✓'
    sub = `${slot ? `Слот ${slot.date} о ${slot.time} минув — ` : ''}${d.final?.sent_at ? `надіслано о ${hhmm(d.final.sent_at)}` : 'збережи в галерею'} · виклади й натисни «✅ Виклала».`
    row = <Row posted />
  }
  return (
    <div className="card mb-3">
      <div className="text-[13.5px] leading-snug">
        <b className="block text-[14.5px]">{title}</b>
        <span style={{ color: 'var(--hint)' }}>{sub}</span>
      </div>
      {row}
    </div>
  )
}

// ───────────── Перемонтаж: стан заявки ─────────────

const BUSY: Partial<Record<RemountKind, [string, string]>> = {
  voice: ['Монтую голос…', '1–2 хв: чищу звук, роблю субтитри, підганяю кадри'],
  music: ['Ставлю іншу музику…', '30–90 с · склейки підганяю під біт'],
  novoice: ['Прибираю голос…', '30–90 с'],
}
const DONE: Partial<Record<RemountKind, string>> = { voice: 'Голос додано ✓', music: 'Нова музика ✓', novoice: 'Голос прибрано ✓' }

function RemountCard({ r, onOk }: { r: NonNullable<VideoDraft['remount']>; onOk: () => void }) {
  if (r.state === 'queued' || r.state === 'running') {
    const [title, sub] = BUSY[r.kind] ?? ['Перемонтовую кадри…', '30–90 с']
    return (
      <div className="card mb-3 flex items-center gap-3">
        <div className="shrink-0"><Spinner /></div>
        <div className="text-[13.5px] leading-snug">
          <b className="block text-[14.5px]">{title}</b>
          <span style={{ color: 'var(--hint)' }}>{sub} · можна закрити апку, відео оновиться саме</span>
        </div>
      </div>
    )
  }
  return (
    <div className="card mb-3 text-[13.5px] leading-snug">
      <b className="block text-[14.5px]">{r.state === 'error' ? 'Не вдалося перемонтувати' : DONE[r.kind] ?? 'Перемонтувала ✓'}</b>
      {r.state === 'error' ? (
        <span style={{ color: 'var(--hint)' }}>{r.error || 'Влад уже бачить помилку.'} Відео лишилось як було.</span>
      ) : r.note.length ? (
        <ul className="mt-1 list-disc pl-4" style={{ color: 'var(--hint)' }}>{r.note.map((x, i) => <li key={i}>{x}</li>)}</ul>
      ) : (
        <span style={{ color: 'var(--hint)' }}>Тексти на своїх кадрах. Переглянь і затверди.</span>
      )}
      <button className="mt-2 text-[14px] font-medium" style={{ color: 'var(--accent)' }} onClick={onOk}>Зрозуміло</button>
    </div>
  )
}

// ───────────── Кадри: прибрати / інший / порядок / коротше (перемонтаж, SQL 020) ─────────────

type ShotsProps = {
  d: VideoDraft
  t: number
  disabled: boolean
  onSeek: (s: number) => void
  onRemount: (job: RemountJob, question: string) => Promise<boolean | undefined>
}

function ShotsEditor({ d, t, disabled, onSeek, onRemount }: ShotsProps) {
  const n = d.shots.length
  const [pick, setPick] = useState<number | null>(null)
  // новий порядок збираємо стрілками, перемонтовуємо один раз — кнопкою
  const [order, setOrder] = useState<number[] | null>(null)
  const ord = order ?? d.shots.map((_, i) => i)
  const reordered = ord.some((v, i) => v !== i)
  const name = (i: number) => `кадр ${i + 1} «${d.shots[i].label}»`

  // після перемонтажу кадри інші — вибір і незбережений порядок скидаємо (правки тексту/обкладинки їх не чіпають)
  const shotsKey = d.shots.map((s) => s.thumb).join('|')
  useEffect(() => { setPick(null); setOrder(null) }, [shotsKey])

  const move = (dir: -1 | 1) => {
    if (pick === null) return
    const at = ord.indexOf(pick)
    const to = at + dir
    if (to < 0 || to >= n) return
    haptic('select')
    const next = [...ord]
    ;[next[at], next[to]] = [next[to], next[at]]
    setOrder(next)
  }
  const run = async (job: RemountJob, q: string) => { if (await onRemount(job, q)) { setPick(null); setOrder(null) } }

  return (
    <div className="card mt-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {ord.map((i, pos) => {
          const s = d.shots[i]
          const playing = !reordered && t >= s.t0 && t < s.t1
          return (
            <button key={i} className="shrink-0 text-left" disabled={disabled} onClick={() => { haptic('select'); setPick(pick === i ? null : i); if (!reordered) onSeek(s.t0 + 0.5) }}>
              <span className="relative block overflow-hidden rounded-lg" style={{
                width: 72, height: 128, outline: pick === i ? '3px solid var(--accent)' : playing ? '2px solid var(--text)' : 'none', outlineOffset: 1,
              }}>
                <img src={s.thumb} alt="" className="h-full w-full object-cover" />
                <span className="absolute top-1 left-1 rounded-full px-1.5 text-[11px] font-semibold" style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}>{pos + 1}</span>
              </span>
              <span className="mt-1 block w-[72px] truncate text-[11.5px]" style={{ color: 'var(--hint)' }}>{s.label}</span>
            </button>
          )
        })}
      </div>

      {reordered ? (
        <>
          <div className="mt-2 text-[13px] leading-snug" style={{ color: 'var(--hint)' }}>Новий порядок: {ord.map((i) => d.shots[i].label).join(' → ')}</div>
          {pick !== null && (
            <div className="qchips">
              <button disabled={disabled || ord.indexOf(pick) === 0} onClick={() => move(-1)}>← Раніше</button>
              <button disabled={disabled || ord.indexOf(pick) === n - 1} onClick={() => move(1)}>Пізніше →</button>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="btn sec" disabled={disabled} onClick={() => { setOrder(null); setPick(null) }}>Як було</button>
            <button className="btn" disabled={disabled} onClick={() => void run({ kind: 'reorder', order: ord }, 'Перемонтувати в такому порядку?')}>Перемонтувати</button>
          </div>
        </>
      ) : pick === null ? (
        <div className="mt-2 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>Торкнись кадру — прибрати, замінити або пересунути.</div>
      ) : (
        <div className="qchips">
          {n > 1 && <button disabled={disabled} onClick={() => void run({ kind: 'remove', shot: pick }, `Прибрати ${name(pick)}?`)}>Прибрати кадр</button>}
          <button disabled={disabled} onClick={() => void run({ kind: 'replace', shot: pick }, `Замінити ${name(pick)} іншим шматком відео?`)}>Інший кадр</button>
          {n > 1 && <button disabled={disabled || pick === 0} onClick={() => move(-1)}>← Раніше</button>}
          {n > 1 && <button disabled={disabled || pick === n - 1} onClick={() => move(1)}>Пізніше →</button>}
        </div>
      )}

      {!d.voice && (
        <div className="qchips" style={{ borderTop: '.5px solid var(--line)', paddingTop: 8 }}>
          <button disabled={disabled} onClick={() => void run({ kind: 'shorter' }, `Зробити коротше? Кожен кадр стане ~на чверть коротшим (зараз ${Math.round(d.dur)} с).`)}>Коротше</button>
        </div>
      )}
    </div>
  )
}

// ───────────── Звук: музика (Mixkit) і голос Іри з бота (сет 6, montage-test/music.py) ─────────────

function SoundCard({ d, disabled, onRemount, onVoice }: { d: VideoDraft; disabled: boolean; onRemount: ShotsProps['onRemount']; onVoice: () => void }) {
  return (
    <div className="card mt-3">
      <div className="flex items-start gap-3">
        <span className="text-[22px] leading-none">♪</span>
        <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
          <b className="block text-[14.5px]">{d.music ? `«${d.music.title}»` : 'Без музики'}</b>
          <span style={{ color: 'var(--hint)' }}>
            {d.music ? `${d.music.artist} · ${MOOD[d.music.mood] ?? d.music.mood}${d.voice ? ' · тихіше під голосом' : ' · склейки під біт'}` : 'можна додати — склейки підлаштую під біт'}
          </span>
        </div>
      </div>
      <div className="qchips">
        <button disabled={disabled} onClick={() => void onRemount({ kind: 'music' }, d.music ? `Поставити іншу музику замість «${d.music.title}»?` : 'Додати музику?')}>
          {d.music ? 'Інша музика' : 'Додати музику'}
        </button>
      </div>

      <div className="mt-3 flex items-start gap-3" style={{ borderTop: '.5px solid var(--line)', paddingTop: 12 }}>
        <span className="text-[20px] leading-none">🎙</span>
        <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
          <b className="block text-[14.5px]">{d.voice ? `Твій голос · ${Math.round(d.voice.dur)} с` : 'Озвучити своїм голосом'}</b>
          <span style={{ color: 'var(--hint)' }}>
            {d.voice ? 'субтитри — на вкладці «Текст» (💬), слова можна виправити' : 'бот попросить голосове 15–30 с — я почищу звук, зроблю субтитри й підгоню кадри'}
          </span>
        </div>
      </div>
      <div className="qchips">
        <button disabled={disabled} onClick={onVoice}>{d.voice ? 'Записати інший голос' : '🎙 Озвучити голосом'}</button>
        {d.voice && (
          <button disabled={disabled} onClick={() => void onRemount({ kind: 'novoice' }, 'Прибрати голос і субтитри? Музика лишиться.')}>Прибрати голос</button>
        )}
      </div>
    </div>
  )
}

// ───────────── Прев'ю 9:16: відео + шар 1080×1920, масштабований під ширину ─────────────

type PreviewProps = {
  d: VideoDraft
  t: number
  sel: string | null
  small: boolean
  vref: React.RefObject<HTMLVideoElement | null>
  onSelect: (id: string) => void
  onMove: (id: string, y: number) => void
  onTap: () => void
}

function Preview({ d, t, sel, small, vref, onSelect, onMove, onTap }: PreviewProps) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(280)
  const drag = useRef<{ id: string; y0: number; py: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const k = w / VW

  const down = (e: RPointerEvent, x: VText) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { id: x.id, y0: x.y, py: e.clientY, moved: false }
  }
  const move = (e: RPointerEvent) => {
    const g = drag.current
    if (!g) return
    const dy = (e.clientY - g.py) / k
    if (Math.abs(dy) > 12) g.moved = true
    if (g.moved) onMove(g.id, Math.round(Math.max(SAFE_TOP, Math.min(SAFE_BOTTOM - 120, g.y0 + dy))))
  }
  const up = (e: RPointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    e.stopPropagation()
    if (!g.moved) { haptic('select'); onSelect(g.id) }
  }

  return (
    <div className="mx-auto" style={{ maxWidth: small ? 170 : 'min(300px, 30vh)', transition: 'max-width .2s' }}>
      <div ref={box} className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: '9 / 16', background: '#000', boxShadow: 'var(--shadow)' }} onClick={onTap}>
        <video ref={vref} src={d.video} poster={d.poster} className="absolute inset-0 h-full w-full object-cover" muted playsInline autoPlay loop preload="auto" />
        <div className="absolute top-0 left-0" style={{ width: VW, height: VH, transform: `scale(${k})`, transformOrigin: '0 0' }} onPointerMove={move} onPointerUp={up}>
          {d.texts.map((x) => {
            const { t0, t1 } = textTimes(d, x)
            const op = x.id === sel ? 1 : opacity(t, t0, t1, d.dur, x.sec ? SUB_FADE : FADE)
            if (op <= 0) return null
            return <TextBlock key={x.id} x={x} op={op} selected={x.id === sel} onDown={(e) => down(e, x)} />
          })}
          {d.wm.kind !== 'off' && <Watermark kind={d.wm.kind} pos={d.wm.pos} color={d.wm.color} />}
          {/* safe zone сторіз: тут Instagram кладе свої кнопки — показуємо, лише коли редагуємо */}
          {sel && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: SAFE_TOP, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.08) 0 18px, transparent 18px 36px)', borderBottom: '3px dashed rgba(255,255,255,.35)' }} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: VH - SAFE_BOTTOM, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.08) 0 18px, transparent 18px 36px)', borderTop: '3px dashed rgba(255,255,255,.35)' }} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function opacity(t: number, t0: number, t1: number, dur: number, fade: number) {
  if (t < t0 || t > t1) return 0
  const a = Math.min(1, (t - t0) / fade)
  const b = t1 >= dur - 0.05 ? 1 : Math.min(1, (t1 - t) / fade)
  return Math.max(0, Math.min(a, b))
}

function TextBlock({ x, op, selected, onDown }: { x: VText; op: number; selected: boolean; onDown: (e: RPointerEvent) => void }) {
  const a = x.scrim
  return (
    <div
      className="absolute"
      style={{ top: x.y, left: 90, width: 900, opacity: op, textAlign: 'center', touchAction: 'none', cursor: 'grab' }}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
    >
      {a > 0 && (
        // м'яка смуга затемнення ±150px навколо тексту, на всю ширину кадру (як scrim у stories.py)
        <div
          className="pointer-events-none absolute"
          style={{ left: -90, right: -90, top: -150, bottom: -150, zIndex: -1, background: `linear-gradient(to bottom, transparent 0, rgba(0,0,0,${a * 0.35}) 75px, rgba(0,0,0,${a}) 150px, rgba(0,0,0,${a}) calc(100% - 150px), rgba(0,0,0,${a * 0.35}) calc(100% - 75px), transparent 100%)` }}
        />
      )}
      <div style={{ outline: selected ? '4px dashed rgba(255,255,255,.85)' : 'none', outlineOffset: 18, borderRadius: 8 }}>
        {x.lines.map((l, i) => <Line key={i} l={l} gap={lineGap(x.lines[i - 1], l)} />)}
      </div>
    </div>
  )
}

function Line({ l, gap }: { l: VLine; gap: number }) {
  const st = STYLES[l.style]
  const f = FONT[st.font]
  const gold = new Set(l.gold)
  return (
    <div
      style={{
        marginTop: gap, marginInline: 'auto', maxWidth: l.maxW ?? 900,
        fontFamily: f.family, fontSize: st.size, lineHeight: f.lh, letterSpacing: st.track,
        textTransform: st.upper ? 'uppercase' : 'none', color: st.gold ? GOLD : '#fff',
        textShadow: '0 4px 7px rgba(0,0,0,.75)', whiteSpace: 'normal', wordBreak: 'normal',
      }}
    >
      {words(l.text).map((w, i) => (
        <span key={i} style={gold.has(i) ? { color: GOLD } : undefined}>{i ? ' ' : ''}{w}</span>
      ))}
    </div>
  )
}

function Watermark({ kind, pos, color }: { kind: Exclude<WmKind, 'off'>; pos: WmPos; color: 'white' | 'gold' }) {
  const b = wmBox(kind, pos)
  return (
    <img
      src={WM[kind].src}
      alt=""
      className="pointer-events-none absolute"
      style={{
        left: b.x, top: b.y, width: b.w, height: b.h, objectFit: 'contain', opacity: 0.88,
        filter: `${color === 'white' ? 'brightness(0) invert(1) ' : ''}drop-shadow(0 2px 4px rgba(0,0,0,.6))`,
      }}
    />
  )
}

// ───────────── Таймлайн: смуга з межами кадрів ─────────────

type TimelineProps = { d: VideoDraft; t: number; playing: boolean; small: boolean; onPlay: () => void; onSeek: (s: number) => void; muted: boolean | null; onSound: () => void }

function Timeline({ d, t, playing, small, onPlay, onSeek, muted, onSound }: TimelineProps) {
  const bar = useRef<HTMLDivElement>(null)
  const seekAt = (e: RPointerEvent) => {
    const r = bar.current?.getBoundingClientRect()
    if (r) onSeek(((e.clientX - r.left) / r.width) * d.dur)
  }
  return (
    <div className="mx-auto mt-2.5 flex items-center gap-2.5" style={{ maxWidth: small ? 240 : 300 }}>
      <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--bg2)' }} onClick={onPlay} aria-label={playing ? 'Пауза' : 'Грати'}>
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>
        )}
      </button>
      <div ref={bar} className="relative h-7 flex-1 touch-none" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seekAt(e) }} onPointerMove={(e) => { if (e.buttons) seekAt(e) }}>
        <div className="absolute inset-x-0 top-1/2 flex h-[6px] -translate-y-1/2 gap-[3px]">
          {d.shots.map((s, i) => {
            const end = i < d.shots.length - 1 ? d.shots[i + 1].t0 : d.dur
            return <i key={i} className="block h-full rounded-full" style={{ flex: end - s.t0, background: 'color-mix(in srgb, var(--hint) 30%, transparent)' }} />
          })}
        </div>
        <div className="absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full" style={{ left: `${(t / d.dur) * 100}%`, background: 'var(--text)' }} />
      </div>
      <span className="w-9 text-right text-[12px] tabular-nums" style={{ color: 'var(--hint)' }}>{t.toFixed(1)}с</span>
      {muted !== null && (
        <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: muted ? 'var(--bg2)' : 'var(--accent)', color: muted ? 'var(--text)' : '#fff' }}
          onClick={onSound} aria-label={muted ? 'Увімкнути звук' : 'Вимкнути звук'}>
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1.5 5h2.5l3.5-3v10l-3.5-3h-2.5z" fill="currentColor" />
            {muted ? <path d="M9.5 5l3.5 4M13 5l-3.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              : <path d="M9.5 4.5a3.5 3.5 0 0 1 0 5M11 3a5.5 5.5 0 0 1 0 8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />}
          </svg>
        </button>
      )}
    </div>
  )
}

// ───────────── Редактор одного тексту ─────────────

function TextEditor({ d, x, onChange, onRemove }: { d: VideoDraft; x: VText; onChange: (fn: (x: VText) => void) => void; onRemove: () => void }) {
  const toggleShot = (i: number) => {
    haptic('select')
    onChange((q) => {
      // кадри — суцільний діапазон: тап за межами розширює, тап по краю звужує
      if (i < q.from) q.from = i
      else if (i > q.to) q.to = i
      else if (q.from === q.to) return
      else if (i === q.from) q.from++
      else if (i === q.to) q.to--
      else { q.from = i; q.to = i }
    })
  }
  return (
    <div className="card mt-3">
      {x.lines.map((l, i) => (
        <div key={i} className="mb-3 pb-3" style={{ borderBottom: '.5px solid var(--line)' }}>
          <div className="flex items-center gap-2">
            <input className="in flex-1" style={{ height: 40 }} value={l.text} onChange={(e) => onChange((q) => {
              q.lines[i].text = e.target.value
              q.lines[i].gold = q.lines[i].gold.filter((g) => g < words(e.target.value).length)
            })} />
            {x.lines.length > 1 && (
              <button className="h-10 w-9 shrink-0 text-[18px]" style={{ color: 'var(--hint)' }} aria-label="Прибрати рядок" onClick={() => onChange((q) => { q.lines.splice(i, 1) })}>✕</button>
            )}
          </div>
          <div className="qchips">
            {(Object.keys(STYLES) as LineStyle[]).map((s) => (
              <button key={s} className={l.style === s ? 'on' : ''} onClick={() => onChange((q) => { q.lines[i].style = s })}>{STYLES[s].name}</button>
            ))}
          </div>
          {!STYLES[l.style].gold && words(l.text).length > 1 && (
            <>
              <div className="mt-2 text-[12.5px]" style={{ color: 'var(--hint)' }}>Золотом — торкнись слова:</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {words(l.text).map((w, wi) => {
                  const on = l.gold.includes(wi)
                  return (
                    <button key={wi} className="rounded-md px-2 py-0.5 text-[14px]" style={{ background: on ? GOLD : 'var(--bg2)', color: on ? '#2A211B' : 'var(--text)' }}
                      onClick={() => onChange((q) => { const g = q.lines[i].gold; q.lines[i].gold = on ? g.filter((z) => z !== wi) : [...g, wi] })}>{w}</button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      ))}
      <button className="text-[14px] font-medium" style={{ color: 'var(--accent)' }} onClick={() => onChange((q) => { q.lines.push({ text: 'Ще рядок', style: 'sub', gold: [] }) })}>＋ Рядок</button>

      <div className="mt-4 text-[13px] font-semibold">Де на екрані</div>
      <div className="qchips" style={{ marginTop: 6 }}>
        {POS.map((p) => <button key={p.name} className={Math.abs(x.y - p.y) < 60 ? 'on' : ''} onClick={() => onChange((q) => { q.y = p.y })}>{p.name}</button>)}
      </div>
      {x.sec ? (
        <div className="mt-4 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>
          💬 Субтитр твого голосу: {x.sec[0].toFixed(1)}–{x.sec[1].toFixed(1)} с. Слова — як почув Whisper: виправ, якщо треба. Час іде за голосом.
        </div>
      ) : (
        <>
          <div className="mt-4 text-[13px] font-semibold">На яких кадрах</div>
          <div className="qchips" style={{ marginTop: 6 }}>
            {d.shots.map((s, i) => (
              <button key={i} className={i >= x.from && i <= x.to ? 'on' : ''} onClick={() => toggleShot(i)}>{i + 1} · {s.label}</button>
            ))}
          </div>
        </>
      )}
      <div className="mt-4 text-[13px] font-semibold">Затемнення під текстом</div>
      <div className="seg mt-1.5" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {SCRIM.map((s) => <button key={s.name} className={Math.abs(x.scrim - s.a) < 0.1 || (s.a === 0.28 && x.scrim > 0.1 && x.scrim < 0.4) ? 'on' : ''} onClick={() => onChange((q) => { q.scrim = s.a })}>{s.name}</button>)}
      </div>
      <button className="mt-4 text-[14px]" style={{ color: 'var(--bad)' }} onClick={onRemove}>Прибрати цей текст</button>
    </div>
  )
}

// ───────────── Водяний знак ─────────────

function WmEditor({ d, onChange }: { d: VideoDraft; onChange: (fn: (x: VideoDraft) => void) => void }) {
  const kinds: WmKind[] = ['wm2', 'wm1', 'wm3', 'off']
  return (
    <div className="card mt-3">
      <div className="text-[13px] font-semibold">Який знак</div>
      <div className="seg mt-1.5" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {kinds.map((k) => <button key={k} className={d.wm.kind === k ? 'on' : ''} onClick={() => { haptic('select'); onChange((n) => { n.wm.kind = k }) }}>{k === 'off' ? 'Без' : WM[k].name}</button>)}
      </div>
      {d.wm.kind !== 'off' && (
        <>
          <div className="mt-4 text-[13px] font-semibold">Де</div>
          <div className="qchips" style={{ marginTop: 6 }}>
            {WM_POS.map((p) => <button key={p.id} className={d.wm.pos === p.id ? 'on' : ''} onClick={() => onChange((n) => { n.wm.pos = p.id })}>{p.name}</button>)}
          </div>
          <div className="mt-4 text-[13px] font-semibold">Колір</div>
          <div className="seg mt-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className={d.wm.color === 'white' ? 'on' : ''} onClick={() => onChange((n) => { n.wm.color = 'white' })}>Білий</button>
            <button className={d.wm.color === 'gold' ? 'on' : ''} onClick={() => onChange((n) => { n.wm.color = 'gold' })}>Золотий</button>
          </div>
          <div className="mt-3 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>
            Для сторіз радимо коло внизу праворуч. Якщо внизу буде стікер-опитування — переклади знак вгору.
          </div>
        </>
      )}
    </div>
  )
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s)

import { useEffect, useRef, useState } from 'react'
import { ApiError, getHotels, hotelAction, hotelAddPhotos, hotelUploadUrl, type HotelItem } from '../lib/api'
import { prepareAll, uploadSequential } from '../lib/image'
import { confirmAction, haptic, isDemo } from '../lib/tg'
import { Spinner } from './ui'

// Вкладка «Готелі»: тумблер Активний / На паузі. Готель на паузі не потрапляє в план тижня,
// а майбутні ненаписані пости про нього пропускаються (їх можна повернути, коли знімеш паузу)
const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })

export function HotelsScreen() {
  const [hotels, setHotels] = useState<HotelItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [upl, setUpl] = useState<{ id: string; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const target = useRef('')

  useEffect(() => {
    getHotels()
      .then((d) => setHotels(d.hotels))
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 503 ? 'schema_pending' : e instanceof Error ? e.message : String(e)))
  }, [])

  const say = (t: string, ms = 2500) => {
    setToast(t)
    setTimeout(() => setToast(''), ms)
  }

  const set = async (h: HotelItem, pause: boolean) => {
    if (busy || h.paused === pause) return
    if (pause && !(await confirmAction(`Поставити «${h.name}» на паузу? Агент не братиме його в план, а майбутні ненаписані пости про нього пропустяться.`))) return
    setBusy(h.hotel_id)
    try {
      const r = await hotelAction(pause ? 'pause' : 'resume', h.hotel_id)
      setHotels(r.hotels)
      haptic('success')
      say(pause ? `На паузі. Пропущено слотів: ${r.skipped ?? 0}` : `Знову активний. Повернуто слотів: ${r.restored ?? 0}`)
    } catch (e) {
      haptic('error')
      say(e instanceof Error ? e.message : String(e), 3500)
    } finally {
      setBusy(null)
    }
  }

  // Фото в бібліотеку готелю без поста: до 10 за раз, вантажаться по черзі, опис агент дописує сам
  const addPhotos = async (list: FileList | null) => {
    const files = Array.from(list ?? []).slice(0, 10)
    const id = target.current
    if (!files.length || !id || upl) return
    setUpl({ id, text: 'Готую фото…' })
    try {
      const prep = await prepareAll(files)
      if (!prep.ok.length) throw new Error(prep.lastError || 'Не вдалося відкрити фото')
      const { items, failed } = await uploadSequential(prep.ok, () => hotelUploadUrl(id), isDemo, (d, t) => setUpl({ id, text: `Завантажую ${Math.min(d + 1, t)} з ${t}…` }))
      if (!items.length) throw new Error('Фото не завантажились — перевір інтернет і спробуй ще раз')
      const r = await hotelAddPhotos(id, items)
      prep.ok.forEach((p) => URL.revokeObjectURL(p.preview))
      setHotels(r.hotels)
      haptic('success')
      const bad = failed + prep.failed
      say(bad ? `Додала ${items.length}, ${bad} не вийшло — спробуй ті ще раз` : `Додала ${items.length} фото в бібліотеку готелю`, 3500)
    } catch (e) {
      haptic('error')
      say(e instanceof Error ? e.message : String(e), 3500)
    } finally {
      setUpl(null)
    }
  }

  const card = (h: HotelItem) => (
    <div key={h.hotel_id} className="card mt-2.5" style={{ opacity: h.paused ? 0.75 : 1 }}>
      <b className="block text-[15.5px]">{h.name}</b>
      <span className="flex flex-wrap items-center gap-1.5 pt-1">
        {h.country && <span className="chip">{h.country}</span>}
        <span className={`chip ${h.photos ? '' : 'warn'}`}>{h.photos ? `фото: ${h.photos}` : 'нема фото'}</span>
        <span className="chip">{h.last_post ? `останній пост: ${fmtDate(h.last_post)}` : 'ще не було постів'}</span>
        {!h.paused && <span className="chip">у плані: {h.upcoming}</span>}
        {h.paused && h.paused_at && <span className="chip">з {fmtDate(h.paused_at)}</span>}
      </span>
      <div className="seg mt-2.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <button className={!h.paused ? 'on' : ''} disabled={busy === h.hotel_id} onClick={() => void set(h, false)}>Активний</button>
        <button className={h.paused ? 'on' : ''} disabled={busy === h.hotel_id} onClick={() => void set(h, true)}>На паузі</button>
      </div>
      <button className="btn sec mt-2.5" style={{ height: 40, fontSize: 14 }} disabled={!!upl} onClick={() => { target.current = h.hotel_id; fileRef.current?.click() }}>
        {upl?.id === h.hotel_id ? upl.text : '+ Фото в бібліотеку'}
      </button>
    </div>
  )

  const active = (hotels ?? []).filter((h) => !h.paused)
  const paused = (hotels ?? []).filter((h) => h.paused)
  return (
    <div className="px-4 pt-3.5 pb-6">
      <h1 className="serif mt-1.5 mb-3 text-[28px]">Готелі</h1>
      {error === 'schema_pending' ? (
        <div className="card mt-4 text-[14px] leading-snug" style={{ color: 'var(--hint)' }}>Готелі ще налаштовуємо — скоро з'являться тут.</div>
      ) : error ? (
        <div className="card mt-4 text-[14px]" style={{ color: 'var(--bad)' }}>Не вдалося завантажити. {error}</div>
      ) : !hotels ? (
        <div className="mt-10 flex justify-center"><Spinner /></div>
      ) : (
        <>
          <div className="mx-0.5 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
            Готель на паузі агент не бере в план і не пише про нього. Знімеш паузу — він повернеться в план з наступного тижня.
          </div>
          <div className="mx-0.5 mt-4 text-[13px] font-semibold" style={{ color: 'var(--hint)' }}>Активні · {active.length}</div>
          {active.map(card)}
          {paused.length > 0 && (
            <>
              <div className="mx-0.5 mt-5 text-[13px] font-semibold" style={{ color: 'var(--hint)' }}>На паузі · {paused.length}</div>
              {paused.map(card)}
            </>
          )}
        </>
      )}
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = '' }} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

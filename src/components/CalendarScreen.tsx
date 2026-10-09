import { useState } from 'react'
import { reviewAction, type QueueItem } from '../lib/api'
import { haptic } from '../lib/tg'
import { PILLAR, PLATFORM } from './PostScreen'
import { Label } from './ui'

type Filter = 'all' | 'telegram' | 'instagram' | 'threads'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Усі' },
  { id: 'telegram', label: 'TG' },
  { id: 'instagram', label: 'IG' },
  { id: 'threads', label: 'Threads' },
]

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// «сьогодні · 19:00», «завтра · 10:00», «пт, 17 жовт. · 13:00» (дата — день у Києві, без часового поясу)
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function whenLabel(date: string, time: string | null) {
  const today = new Date()
  const tomorrow = new Date(Date.now() + 864e5)
  const day = date === ymd(today) ? 'сьогодні' : date === ymd(tomorrow) ? 'завтра'
    : new Date(`${date}T12:00:00`).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' })
  return day + (time ? ` · ${time.slice(0, 5)}` : '')
}

const when = (q: QueueItem) => (q.scheduled_for ? whenLabel(q.scheduled_for, q.slot_time) : `слот: ${q.day}`)
const overdue = (q: QueueItem) => Boolean(q.scheduled_for && `${q.scheduled_for}T${(q.slot_time ?? '23:59').slice(0, 5)}` < `${ymd(new Date())}T${new Date().toTimeString().slice(0, 5)}`)

// Фаза 5: затверджені пости по платформах + ручна публікація. Текст і фото забирає з поста («Надіслати в чат»), тут — позначка «опубліковано»
export function CalendarScreen({ queue, onOpen, onChanged }: { queue: QueueItem[] | null; onOpen: (id: string) => void; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  // Зміна дати: id поста, який зараз редагуємо, + чернетка дати/часу
  const [edit, setEdit] = useState<{ id: string; date: string; time: string } | null>(null)

  const items = (queue ?? []).filter((q) => filter === 'all' || q.platform === filter)
  const toPublish = items
    .filter((q) => q.review_status === 'approved')
    .sort((a, b) => `${a.scheduled_for ?? '9999'}${a.slot_time ?? ''}`.localeCompare(`${b.scheduled_for ?? '9999'}${b.slot_time ?? ''}`))
  const published = items
    .filter((q) => q.review_status === 'published')
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))

  const mark = async (q: QueueItem, action: 'publish' | 'unpublish') => {
    setBusyId(q.id)
    try {
      await reviewAction(q.id, q.version_no, action)
      haptic('success')
      setToast(action === 'publish' ? 'Позначила опублікованим' : 'Повернула в «До публікації»')
      setTimeout(() => setToast(''), 2000)
      onChanged()
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : 'Помилка')
      setTimeout(() => setToast(''), 2500)
      onChanged()
    } finally {
      setBusyId(null)
    }
  }

  const saveDate = async (q: QueueItem) => {
    if (!edit) return
    setBusyId(q.id)
    try {
      await reviewAction(q.id, q.version_no, 'reschedule', { date: edit.date, time: edit.time })
      haptic('success')
      setToast(`Перенесла на ${whenLabel(edit.date, edit.time)}`)
      setTimeout(() => setToast(''), 2000)
      setEdit(null)
      onChanged()
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : 'Помилка')
      setTimeout(() => setToast(''), 2500)
    } finally {
      setBusyId(null)
    }
  }

  const row = (q: QueueItem, i: number, isPublished: boolean) => {
    const plat = PLATFORM[q.platform] ?? { name: q.platform, cls: '' }
    const editing = edit?.id === q.id
    return (
      <div key={q.id} style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
      <div className="flex items-center gap-2.5 py-2.5">
        <button className="min-w-0 flex-1 text-left" onClick={() => { haptic('tap'); onOpen(q.id) }}>
          <span className="flex items-center gap-1.5">
            <span className={`chip ${plat.cls}`}>{plat.name}</span>
            {isPublished && q.published_at ? (
              <span className="text-[12.5px]" style={{ color: 'var(--hint)' }}>
                виклала {new Date(q.published_at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}
              </span>
            ) : (
              <span
                role="button"
                className="text-[12.5px] underline decoration-dotted underline-offset-2"
                style={{ color: overdue(q) ? 'var(--warn)' : 'var(--hint)' }}
                onClick={(e) => {
                  e.stopPropagation()
                  haptic('tap')
                  setEdit({ id: q.id, date: q.scheduled_for ?? ymd(new Date(Date.now() + 864e5)), time: (q.slot_time ?? '12:00').slice(0, 5) })
                }}
              >
                {when(q)}{overdue(q) ? ' · час минув' : ''}
              </span>
            )}
          </span>
          <b className="mt-1 block truncate text-[14.5px]">{q.hotel_name ?? q.tour_title ?? cap(PILLAR[q.pillar] ?? q.pillar)}</b>
          <span className="block truncate text-[13px]" style={{ color: 'var(--hint)' }}>{q.preview}</span>
        </button>
        {isPublished ? (
          <button className="chip okc" disabled={busyId === q.id} onClick={() => void mark(q, 'unpublish')} title="Повернути">✓ викладено</button>
        ) : (
          <button className="btn sec" style={{ width: 'auto', height: 34, padding: '0 10px', fontSize: 13 }} disabled={busyId === q.id} onClick={() => void mark(q, 'publish')}>
            {busyId === q.id ? '…' : 'Виклала'}
          </button>
        )}
      </div>
      {editing && edit && (
        <div className="flex items-center gap-2 pb-3">
          <input type="date" className="in" style={{ flex: 1, height: 38 }} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
          <input type="time" className="in" style={{ width: 96, height: 38 }} value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} />
          <button className="btn" style={{ width: 'auto', height: 38, padding: '0 12px', fontSize: 13 }} disabled={busyId === q.id || !edit.date || !edit.time} onClick={() => void saveDate(q)}>OK</button>
          <button className="btn sec" style={{ width: 'auto', height: 38, padding: '0 10px', fontSize: 13 }} onClick={() => setEdit(null)}>✕</button>
        </div>
      )}
      </div>
    )
  }

  return (
    <div className="px-4 pt-3.5 pb-6">
      <h1 className="serif mt-1.5 mb-3 text-[28px]">Календар</h1>
      <div className="seg" style={{ gridTemplateColumns: `repeat(${FILTERS.length}, 1fr)` }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => { haptic('select'); setFilter(f.id) }}>{f.label}</button>
        ))}
      </div>

      {queue === null ? null : !toPublish.length && !published.length ? (
        <div className="card mt-4 text-center text-[14px] leading-snug" style={{ color: 'var(--hint)' }}>
          Тут з'являться затверджені пости. Відкрий пост → «Надіслати в чат» → виклади → «Виклала».
        </div>
      ) : (
        <>
          <Label>До публікації · {toPublish.length}</Label>
          {toPublish.length ? (
            <div className="card" style={{ padding: '4px 14px' }}>{toPublish.map((q, i) => row(q, i, false))}</div>
          ) : (
            <div className="card text-[14px]" style={{ color: 'var(--hint)' }}>Усе затверджене вже викладено</div>
          )}
          {published.length > 0 && (
            <>
              <Label>Викладено · 30 днів</Label>
              <div className="card" style={{ padding: '4px 14px' }}>{published.map((q, i) => row(q, i, true))}</div>
            </>
          )}
          <div className="mx-2 mt-3 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>Тапни дату, щоб перенести. Текст і фото — у пості: «Копіювати текст» або «Надіслати в чат».</div>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

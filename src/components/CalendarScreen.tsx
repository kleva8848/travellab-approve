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

const when = (q: QueueItem) =>
  q.scheduled_for
    ? new Date(q.scheduled_for).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' }) + (q.slot_time ? ` · ${q.slot_time.slice(0, 5)}` : '')
    : `слот: ${q.day}`

// Фаза 5: затверджені пости по платформах + ручна публікація. Текст і фото забирає з поста («Надіслати в чат»), тут — позначка «опубліковано»
export function CalendarScreen({ queue, onOpen, onChanged }: { queue: QueueItem[] | null; onOpen: (id: string) => void; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const items = (queue ?? []).filter((q) => filter === 'all' || q.platform === filter)
  const toPublish = items.filter((q) => q.review_status === 'approved')
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

  const row = (q: QueueItem, i: number, isPublished: boolean) => {
    const plat = PLATFORM[q.platform] ?? { name: q.platform, cls: '' }
    return (
      <div key={q.id} className="flex items-center gap-2.5 py-2.5" style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
        <button className="min-w-0 flex-1 text-left" onClick={() => { haptic('tap'); onOpen(q.id) }}>
          <span className="flex items-center gap-1.5">
            <span className={`chip ${plat.cls}`}>{plat.name}</span>
            <span className="text-[12.5px]" style={{ color: 'var(--hint)' }}>
              {isPublished && q.published_at ? `виклала ${new Date(q.published_at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}` : when(q)}
            </span>
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
          <div className="mx-2 mt-3 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>Текст і фото — у пості: «Копіювати текст» або «Надіслати в чат».</div>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

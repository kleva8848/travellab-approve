import { useEffect, useState } from 'react'
import { getPlan, reviewAction, type PlanItem, type WeekPlan } from '../lib/api'
import { audienceOf, formatOf } from '../lib/audience'
import { confirmAction, haptic } from '../lib/tg'
import { AudienceCard } from './AudienceCard'
import { PILLAR, PLATFORM } from './PostScreen'
import { Spinner } from './ui'
import { PublishedButton, usePublished } from '../lib/usePublished'

// Вкладка «План»: увесь тиждень наперед — що, де, коли, в якому форматі, для кого і на яке питання.
// На відміну від «Календаря» (лише затверджене) тут і слоти, які агент ще не написав
const WEEKS: { id: number; label: string }[] = [
  { id: -1, label: 'Минулий' },
  { id: 0, label: 'Цей тиждень' },
  { id: 1, label: 'Наступний' },
]

const STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: 'ще не написано', cls: '' },
  generating: { label: 'агент пише', cls: '' },
  regenerating: { label: 'агент переписує', cls: '' },
  needs_data: { label: 'потрібна відповідь', cls: 'warn' },
  ready_for_review: { label: 'на перегляд', cls: 'warn' },
  changes_requested: { label: 'правка в роботі', cls: '' },
  approved: { label: 'затверджено', cls: 'okc' },
  published: { label: '✓ викладено', cls: 'okc' },
  skipped: { label: 'пропущено', cls: '' },
  missed: { label: 'не вийшов', cls: '' },
  failed: { label: 'помилка', cls: 'warn' },
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const dayTitle = (date: string, today: string) => {
  const d = new Date(`${date}T12:00:00`).toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' })
  return cap(d) + (date === today ? ' · сьогодні' : '')
}

export function PlanScreen({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const [week, setWeek] = useState(0)
  const [data, setData] = useState<WeekPlan | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [showSkipped, setShowSkipped] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const pub = usePublished(onChanged)

  useEffect(() => {
    let live = true
    setData(null)
    setError('')
    getPlan(week)
      .then((d) => { if (live) setData(d) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [week, reload])

  // Пропустити слот / повернути пропущений. Пост без тексту → planned, з текстом → туди, звідки пропустили
  const skip = async (q: PlanItem, undo: boolean) => {
    if (busy) return
    if (!undo && !(await confirmAction('Пропустити цей слот? Агент його не писатиме. Повернути можна внизу в «Пропущених».'))) return
    setBusy(q.id)
    try {
      await reviewAction(q.id, q.version_no, undo ? 'unskip' : 'skip')
      haptic('success')
      setToast(undo ? 'Повернула в план' : 'Пропустила')
      setTimeout(() => setToast(''), 1800)
      setOpen(null)
      setReload((n) => n + 1)
      onChanged()
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : 'Помилка')
      setTimeout(() => setToast(''), 3000)
    } finally {
      setBusy(null)
    }
  }

  const skipped = (data?.items ?? []).filter((i) => i.review_status === 'skipped')
  const days = new Map<string, PlanItem[]>()
  for (const x of (data?.items ?? []).filter((i) => !pub.hidden.has(i.id) && i.review_status !== 'skipped')) {
    const k = x.scheduled_for ?? ''
    days.set(k, [...(days.get(k) ?? []), x])
  }
  // Фокус тижня — портрет, який WF-018 поставив на тиждень (найчастіший у слотах)
  const counts = new Map<string, number>()
  for (const x of data?.items ?? []) {
    const p = audienceOf(x).persona
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const focus = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const shown = (data?.items ?? []).filter((i) => !pub.hidden.has(i.id) && i.review_status !== 'skipped')
  const fmtRange = (d: WeekPlan) =>
    `${new Date(`${d.from}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })} – ${new Date(`${d.to}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}`

  const row = (q: PlanItem, i: number) => {
    const plat = PLATFORM[q.platform] ?? { name: q.platform, cls: '' }
    const st = STATUS[q.review_status] ?? { label: q.review_status, cls: '' }
    const canOpen = Boolean(q.current_version_id) || q.review_status === 'needs_data'
    const expanded = open === q.id
    return (
      <div key={q.id} style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
        <div className="flex items-center gap-2">
        <button
          className="block min-w-0 flex-1 py-2.5 text-left"
          onClick={() => {
            haptic('tap')
            if (canOpen) onOpen(q.id)
            else setOpen(expanded ? null : q.id)
          }}
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold tabular-nums">{(q.slot_time ?? '').slice(0, 5)}</span>
            <span className={`chip ${plat.cls}`}>{plat.name}</span>
            <span className="chip">{formatOf(q, q.photos)}</span>
            <span className={`chip ${st.cls}`}>{st.label}</span>
          </span>
          <b className="mt-1 block truncate text-[14.5px]">{q.hotel_name ?? q.tour_title ?? cap(PILLAR[q.pillar] ?? q.pillar)}</b>
          {q.preview && <span className="block truncate text-[13px]" style={{ color: 'var(--hint)' }}>{q.preview}</span>}
          <AudienceCard plan={q} compact />
        </button>
        {q.review_status === 'approved' && <PublishedButton onClick={() => void pub.mark(q)} />}
        </div>
        {expanded && (
          <div className="pb-3">
            <AudienceCard plan={q} />
            <div className="text-[13px]" style={{ color: 'var(--hint)' }}>
              Пост ще не написано — агент підготує його приблизно за 3 дні до дати, тоді він з'явиться в «Сьогодні» на перегляд.
            </div>
            {q.review_status === 'planned' && (
              <button className="mt-2 text-[14px]" style={{ color: 'var(--hint)' }} disabled={busy === q.id} onClick={() => void skip(q, false)}>Пропустити цей слот</button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="px-4 pt-3.5 pb-6">
      <h1 className="serif mt-1.5 mb-3 text-[28px]">План</h1>
      <div className="seg" style={{ gridTemplateColumns: `repeat(${WEEKS.length}, 1fr)` }}>
        {WEEKS.map((w) => (
          <button key={w.id} className={week === w.id ? 'on' : ''} onClick={() => { haptic('select'); setWeek(w.id) }}>{w.label}</button>
        ))}
      </div>

      {error ? (
        <div className="card mt-4 text-[14px]" style={{ color: 'var(--bad)' }}>Не вдалося завантажити план. {error}</div>
      ) : !data ? (
        <div className="mt-10 flex justify-center"><Spinner /></div>
      ) : (
        <>
          <div className="mx-0.5 mt-3 text-[13px]" style={{ color: 'var(--hint)' }}>
            {fmtRange(data)} · {shown.length} {shown.length === 1 ? 'публікація' : 'публікацій'}
          </div>
          {focus && (
            <div className="card mt-2.5 text-[14px] leading-snug" style={{ boxShadow: 'none', background: 'var(--bg2)' }}>
              🎯 Фокус тижня: <b>{focus}</b>
            </div>
          )}
          {!shown.length ? (
            <div className="card mt-4 text-center text-[14px] leading-snug" style={{ color: 'var(--hint)' }}>
              {week > 0 ? 'План наступного тижня агент складає в неділю ввечері.' : 'На цей тиждень публікацій немає.'}
            </div>
          ) : (
            [...days.entries()].map(([date, list]) => (
              <div key={date}>
                <div className="mx-0.5 mt-5 mb-2 text-[13px] font-semibold" style={{ color: date === data.today ? 'var(--text)' : 'var(--hint)' }}>
                  {date ? dayTitle(date, data.today) : 'Без дати'}
                </div>
                <div className="card" style={{ padding: '2px 14px' }}>{list.map(row)}</div>
              </div>
            ))
          )}
          {skipped.length > 0 && (
            <div className="mt-5">
              <button className="mx-0.5 text-[13px] font-semibold" style={{ color: 'var(--hint)' }} onClick={() => { haptic('tap'); setShowSkipped(!showSkipped) }}>
                Пропущені · {skipped.length} {showSkipped ? '▴' : '▾'}
              </button>
              {showSkipped && (
                <div className="card mt-2" style={{ padding: '2px 14px' }}>
                  {skipped.map((q, i) => (
                    <div key={q.id} className="flex items-center gap-2" style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
                      <div className="min-w-0 flex-1 py-2.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] tabular-nums" style={{ color: 'var(--hint)' }}>{q.scheduled_for ? dayTitle(q.scheduled_for, data.today).split(',')[0] : ''}</span>
                          <span className={`chip ${(PLATFORM[q.platform] ?? { cls: '' }).cls}`}>{(PLATFORM[q.platform] ?? { name: q.platform }).name}</span>
                        </span>
                        <b className="mt-1 block truncate text-[14.5px]">{q.hotel_name ?? q.tour_title ?? cap(PILLAR[q.pillar] ?? q.pillar)}</b>
                      </div>
                      <button className="chip" disabled={busy === q.id} onClick={() => void skip(q, true)}>Повернути</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="mx-2 mt-3 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>
            Тапни пост, щоб відкрити. Дату переносиш у «Календарі» після затвердження.
          </div>
        </>
      )}
      {pub.node}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

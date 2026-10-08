import type { Me, QueueItem } from '../lib/api'
import { haptic } from '../lib/tg'
import { PILLAR, PLATFORM } from './PostScreen'
import { Label, Spinner } from './ui'

const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота']
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня']

function greeting(h: number) {
  if (h < 5) return 'Доброї ночі'
  if (h < 12) return 'Доброго ранку'
  if (h < 18) return 'Доброго дня'
  return 'Доброго вечора'
}

// Звертання в кличному відмінку для відомих імен, інакше як є
const VOCATIVE: Record<string, string> = { 'Іра': 'Іро', 'Ira': 'Іро', 'Ірина': 'Ірино', 'Влад': 'Владе', 'Vlad': 'Владе' }

type Props = { me: Me; queue: QueueItem[] | null; queueError: string; onOpen: (id: string) => void; onRetry: () => void }

const WAITING = new Set(['ready_for_review', 'changes_requested', 'needs_data'])

// Черга Іри: що чекає на неї (огляд), що агент переробляє, що вже затверджено
export function TodayScreen({ me, queue, queueError, onOpen, onRetry }: Props) {
  const now = new Date()
  const day = DAYS[now.getDay()]
  const name = me.first_name ? VOCATIVE[me.first_name] ?? me.first_name : null
  const waiting = (queue ?? []).filter((q) => WAITING.has(q.review_status))
  const working = (queue ?? []).filter((q) => q.review_status === 'regenerating')
  const approved = (queue ?? []).filter((q) => q.review_status === 'approved')
  const allDone = queue && !waiting.length && !working.length

  return (
    <div className="px-4 pt-3.5 pb-6">
      <div className="text-[13px]" style={{ color: 'var(--hint)' }}>
        {day[0].toUpperCase() + day.slice(1)}, {now.getDate()} {MONTHS[now.getMonth()]}
      </div>
      <h1 className="serif mt-1.5 mb-0.5 text-[32px] leading-[1.05]">
        {greeting(now.getHours())}{name ? `, ${name}` : ''}
      </h1>
      <div className="mb-4 text-[13px]" style={{ color: 'var(--hint)' }}>
        {allDone ? 'Зараз від тебе нічого не треба.' : 'Тут лише те, що чекає на тебе. Решту агент робить сам.'}
      </div>

      {queueError === 'schema_pending' ? (
        <div className="card text-center">
          <div className="serif text-[22px]">Ще налаштовуємо</div>
          <div className="mt-1 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>Пости з'являться тут, щойно Влад завершить налаштування бази.</div>
        </div>
      ) : queueError ? (
        <div className="card text-center">
          <div className="text-[14px]" style={{ color: 'var(--hint)' }}>Не вдалося завантажити пости. {queueError}</div>
          <button className="btn sec mt-3" onClick={onRetry}>Спробувати ще</button>
        </div>
      ) : !queue ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <>
          {waiting.length > 0 && (
            <button className="card flex w-full items-center gap-3.5 text-left" onClick={() => { haptic('tap'); onOpen(waiting[0].id) }}>
              <span className="serif min-w-[38px] text-[44px] leading-none">{waiting.length}</span>
              <span>
                <b className="block text-[16px]">{plural(waiting.length, 'пост', 'пости', 'постів')} на перегляд</b>
                <span className="text-[13.5px]" style={{ color: 'var(--hint)' }}>по одному · ~{Math.max(1, Math.round(waiting.length * 0.7))} хв</span>
              </span>
              <span className="ml-auto text-[22px]" style={{ color: 'var(--hint)' }}>›</span>
            </button>
          )}
          {allDone && (
            <div className="card text-center">
              <div className="serif text-[22px]">Усе переглянуто</div>
              <div className="mt-1 text-[13.5px]" style={{ color: 'var(--hint)' }}>Нові пости агент надішле в чат, коли будуть готові.</div>
            </div>
          )}

          <List title="Чекають тебе" items={waiting} onOpen={onOpen} />
          <List title="Агент переробляє" items={working} onOpen={onOpen} badge={<span className="chip warn">переробляю</span>} />
          <List title="Затверджено" items={approved} onOpen={onOpen} badge={<span className="chip okc">в календарі</span>} />
        </>
      )}
    </div>
  )
}

function List({ title, items, onOpen, badge }: { title: string; items: QueueItem[]; onOpen: (id: string) => void; badge?: React.ReactNode }) {
  if (!items.length) return null
  return (
    <>
      <Label>{title}</Label>
      <div className="card" style={{ padding: '4px 14px' }}>
        {items.map((q, i) => {
          const plat = PLATFORM[q.platform] ?? { name: q.platform, cls: '' }
          return (
            <button key={q.id} className="flex w-full items-center gap-2.5 py-2.5 text-left" style={{ borderTop: i ? '.5px solid var(--line)' : 0 }} onClick={() => { haptic('tap'); onOpen(q.id) }}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={`chip ${plat.cls}`}>{plat.name}</span>
                  <span className="text-[12.5px]" style={{ color: 'var(--hint)' }}>{PILLAR[q.pillar] ?? q.pillar} · {q.day}</span>
                </span>
                <b className="mt-1 block truncate text-[14.5px]">{q.hotel_name ?? q.tour_title ?? cap(PILLAR[q.pillar] ?? q.pillar)}</b>
                <span className="block truncate text-[13px]" style={{ color: 'var(--hint)' }}>{q.preview}</span>
              </span>
              {badge ?? <span style={{ color: 'var(--hint)' }}>›</span>}
            </button>
          )
        })}
      </div>
    </>
  )
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

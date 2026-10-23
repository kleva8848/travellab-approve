import { AudienceCard } from './AudienceCard'
import type { Me, QueueItem, StoryInfo } from '../lib/api'
import { haptic, isDemo, openTelegram } from '../lib/tg'
import { demoVideos } from '../lib/video'
import { PILLAR, PLATFORM } from './PostScreen'
import { RulesAdmin } from './RulesAdmin'
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

type Props = { me: Me; queue: QueueItem[] | null; story: StoryInfo | null; queueError: string; onOpen: (id: string) => void; onOpenVideo: (id: string) => void; onRetry: () => void }

const WAITING = new Set(['ready_for_review', 'changes_requested', 'needs_data'])

// Черга Іри: що чекає на неї (огляд), що агент переробляє, що вже затверджено
export function TodayScreen({ me, queue, story, queueError, onOpen, onOpenVideo, onRetry }: Props) {
  const now = new Date()
  const day = DAYS[now.getDay()]
  const name = me.first_name ? VOCATIVE[me.first_name] ?? me.first_name : null
  const waiting = (queue ?? []).filter((q) => WAITING.has(q.review_status))
  // Пости, де агенту бракує фактів, — окремо: там не перегляд, а питання до Іри
  const asking = waiting.filter((q) => q.review_status === 'needs_data' && q.questions)
  const reviewing = waiting.filter((q) => !asking.includes(q))
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

          {isDemo && <Videos onOpen={onOpenVideo} />}
          <List title="Потрібна твоя відповідь" items={asking} onOpen={onOpen} badge={<span className="chip warn">відповісти</span>} />
          <List title="Чекають тебе" items={reviewing} onOpen={onOpen} />
          <List title="Агент переробляє" items={working} onOpen={onOpen} badge={<span className="chip warn">переробляю</span>} />
          <List title="Затверджено" items={approved} onOpen={onOpen} badge={<span className="chip okc">в календарі</span>} />
          {story && <StoryCard story={story} />}
        </>
      )}
      {me.is_admin && <RulesAdmin />}
    </div>
  )
}

// «🎙 Розповісти історію»: відкриває чат з ботом (/start story) — там підказка і голосове у відповідь → черга історій
function StoryCard({ story }: { story: StoryInfo }) {
  return (
    <>
      <Label>Історія для постів</Label>
      <div className="card">
        <div className="text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>Підказка цього тижня</div>
        <div className="mt-1 text-[15px] leading-snug">{story.hint}</div>
        <button className="btn sec mt-3" onClick={() => { haptic('tap'); openTelegram(story.link) }}>🎙 Розповісти історію</button>
        <div className="mt-1.5 text-center text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>
          {story.queued
            ? `У черзі ${story.queued} ${plural(story.queued, 'історія', 'історії', 'історій')} — піде в суботній пост`
            : 'Відкриється чат з ботом — одне голосове на 1–3 хв, піде в суботній пост'}
        </div>
      </div>
    </>
  )
}

// Сторіз / рілс на перегляд: обкладинка 9:16 + назва (поки лише демо, справжні — наступний крок)
function Videos({ onOpen }: { onOpen: (id: string) => void }) {
  const items = demoVideos()
  return (
    <>
      <Label>Відео на перегляд</Label>
      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {items.map((v) => (
          <button key={v.id} className="shrink-0 text-left" style={{ width: 104 }} onClick={() => { haptic('tap'); onOpen(v.id) }}>
            <span className="relative block overflow-hidden rounded-xl" style={{ width: 104, height: 185, boxShadow: 'var(--shadow)' }}>
              <img src={v.poster} alt="" className="h-full w-full object-cover" />
              <span className="absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[11px]" style={{ background: 'rgba(0,0,0,.5)', color: '#fff' }}>{v.format === 'reel' ? 'рілс' : 'сторіз'} · {Math.round(v.dur)}с</span>
              {v.status === 'approved' && <span className="absolute right-1.5 bottom-1.5 rounded-full px-2 py-0.5 text-[11px]" style={{ background: 'var(--ok)', color: '#fff' }}>✓</span>}
            </span>
            <b className="mt-1.5 block text-[13px] leading-tight">{v.name}</b>
            <span className="text-[12px]" style={{ color: 'var(--hint)' }}>{v.place}</span>
          </button>
        ))}
      </div>
    </>
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
                <AudienceCard plan={q} compact />
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

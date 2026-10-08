import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarScreen } from './components/CalendarScreen'
import { PostScreen } from './components/PostScreen'
import { TodayScreen } from './components/TodayScreen'
import { Center, IconCalendar, IconSun, Spinner } from './components/ui'
import { ApiError, getMe, getQueue, type Me, type QueueItem } from './lib/api'
import { haptic, initTelegram, inTelegram, isDemo, startParam } from './lib/tg'

type Tab = 'today' | 'calendar'

const TABS: { id: Tab; label: string; icon: () => React.JSX.Element }[] = [
  { id: 'today', label: 'Сьогодні', icon: IconSun },
  { id: 'calendar', label: 'Календар', icon: IconCalendar },
]

type Auth = { state: 'loading' } | { state: 'ok'; me: Me } | { state: 'error'; status: number; message: string }

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [auth, setAuth] = useState<Auth>({ state: 'loading' })
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [queueError, setQueueError] = useState('')
  // Відкритий пост: з черги або з кнопки бота (startapp=post_<uuid>)
  const [openId, setOpenId] = useState<string | null>(() => {
    const m = /^post_([0-9a-f-]{36})$/i.exec(startParam())
    return m ? m[1] : null
  })
  // Порядок проходу фіксуємо на момент відкриття, щоб затверджений пост не «стрибав» у степері
  const [session, setSession] = useState<{ order: string[]; done: Set<string> }>({ order: [], done: new Set() })

  const refresh = useCallback(async () => {
    try {
      setQueue(await getQueue())
      setQueueError('')
    } catch (e) {
      setQueueError(e instanceof ApiError && e.status === 503 ? 'schema_pending' : e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    initTelegram()
    if (!inTelegram && !isDemo) {
      setAuth({ state: 'error', status: 401, message: '' })
      return
    }
    getMe()
      .then((me) => setAuth({ state: 'ok', me }))
      .catch((e: unknown) => setAuth({ state: 'error', status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }))
  }, [])

  useEffect(() => {
    if (auth.state === 'ok') void refresh()
  }, [auth.state, refresh])

  const waitingIds = useMemo(
    () => (queue ?? []).filter((q) => ['ready_for_review', 'changes_requested', 'needs_data'].includes(q.review_status)).map((q) => q.id),
    [queue],
  )

  const open = (id: string) => {
    setSession((s) => (s.order.includes(id) ? s : { order: waitingIds.includes(id) ? waitingIds : [id], done: new Set() }))
    setOpenId(id)
  }

  // Наступний непереглянутий у поточному проході; якщо таких нема — на головну
  const next = () => {
    if (!openId) return
    const done = new Set(session.done).add(openId)
    setSession({ ...session, done })
    const rest = session.order.filter((x) => !done.has(x))
    const after = rest.find((x) => session.order.indexOf(x) > session.order.indexOf(openId)) ?? rest[0]
    setOpenId(after ?? null)
    if (!after) void refresh()
  }

  if (auth.state === 'loading') return <Center><Spinner /></Center>
  if (auth.state === 'error') return <AuthError status={auth.status} message={auth.message} />

  if (openId) {
    const order = session.order.includes(openId) ? session.order : [openId]
    return (
      <div className="mx-auto h-full max-w-lg">
        <PostScreen
          id={openId}
          index={order.indexOf(openId)}
          total={order.length}
          order={order}
          doneIds={session.done}
          onBack={() => { setOpenId(null); void refresh() }}
          onNext={next}
          onChanged={() => void refresh()}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full max-w-lg flex-col">
      {isDemo && (
        <div className="px-4 pt-2 text-right">
          <span className="rounded-full px-2 py-0.5 text-[12px]" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>демо</span>
        </div>
      )}
      <main className="flex-1 overflow-y-auto overscroll-contain">
        {tab === 'today' && <TodayScreen me={auth.me} queue={queue} queueError={queueError} onOpen={open} onRetry={() => void refresh()} />}
        {tab === 'calendar' && <CalendarScreen />}
      </main>
      <nav className="flex pt-1.5 pb-[calc(env(safe-area-inset-bottom)+8px)]" style={{ background: 'var(--bg)', borderTop: '0.5px solid var(--line)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className="flex flex-1 flex-col items-center gap-[3px] py-1 text-[11px]"
            style={{ color: tab === t.id ? 'var(--text)' : 'var(--hint)' }}
            onClick={() => { haptic('select'); setTab(t.id) }}
          >
            <t.icon />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

// 401 — відкрито не з Telegram; 403 — TG ID не в ALLOWED_TG_IDS (показуємо ID, щоб переслати Владу)
function AuthError({ status, message }: { status: number; message: string }) {
  return (
    <Center>
      <div className="serif mb-2 text-[26px]">TravelLab</div>
      {status === 401 && <p className="text-[15px] leading-snug" style={{ color: 'var(--hint)' }}>Відкрий застосунок через кнопку «TravelLab» у чаті з ботом.</p>}
      {status === 403 && (
        <p className="text-[15px] leading-snug" style={{ color: 'var(--hint)' }}>
          Немає доступу. Перешли Владу цей номер: <b style={{ color: 'var(--text)' }}>{message.replace('TG ID ', '')}</b>
        </p>
      )}
      {status !== 401 && status !== 403 && (
        <p className="text-[15px] leading-snug" style={{ color: 'var(--hint)' }}>Не вдалося завантажити. {message}</p>
      )}
    </Center>
  )
}

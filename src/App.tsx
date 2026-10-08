import { useEffect, useState } from 'react'
import { CalendarScreen } from './components/CalendarScreen'
import { TodayScreen } from './components/TodayScreen'
import { Center, IconCalendar, IconSun, Spinner } from './components/ui'
import { ApiError, getMe, type Me } from './lib/api'
import { haptic, initTelegram, inTelegram, isDemo } from './lib/tg'

type Tab = 'today' | 'calendar'

const TABS: { id: Tab; label: string; icon: () => React.JSX.Element }[] = [
  { id: 'today', label: 'Сьогодні', icon: IconSun },
  { id: 'calendar', label: 'Календар', icon: IconCalendar },
]

type Auth = { state: 'loading' } | { state: 'ok'; me: Me } | { state: 'error'; status: number; message: string }

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [auth, setAuth] = useState<Auth>({ state: 'loading' })

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

  if (auth.state === 'loading') return <Center><Spinner /></Center>
  if (auth.state === 'error') return <AuthError status={auth.status} message={auth.message} />

  return (
    <div className="mx-auto flex h-full max-w-lg flex-col">
      {isDemo && (
        <div className="px-4 pt-2 text-right">
          <span className="rounded-full px-2 py-0.5 text-[12px]" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>демо</span>
        </div>
      )}
      <main className="flex-1 overflow-y-auto overscroll-contain">
        {tab === 'today' && <TodayScreen me={auth.me} />}
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

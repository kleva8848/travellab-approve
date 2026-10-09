import { useEffect, useRef, useState } from 'react'
import { decideRule, getRules, type Rule, type RuleDecision } from '../lib/api'
import { haptic, startParam } from '../lib/tg'
import { Label } from './ui'

// Лише для Влада (ADMIN_TG_IDS): чого агент навчився з правок Іри. Загальні правила — тільки після ✅,
// решта (готель / платформа / рубрика) діє одразу, її можна вимкнути. Посилання з дайджесту: startapp=rules
export function RulesAdmin() {
  const [data, setData] = useState<{ pending: Rule[]; active: Rule[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showActive, setShowActive] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getRules().then(setData).catch(() => setData({ pending: [], active: [] }))
  }, [])
  useEffect(() => {
    if (data && startParam() === 'rules') ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [data])

  if (!data || (!data.pending.length && !data.active.length)) return null

  const decide = async (r: Rule, d: RuleDecision) => {
    setBusy(r.id)
    try {
      await decideRule(r.id, d)
      haptic(d === 'approve' ? 'success' : 'tap')
      setData(await getRules())
    } catch {
      haptic('error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={ref}>
      <Label>Правила з правок · бачиш лише ти</Label>
      {data.pending.length > 0 && (
        <div className="card" style={{ padding: '4px 14px' }}>
          {data.pending.map((r, i) => (
            <div key={r.id} className="py-2.5" style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
              <div className="text-[12.5px]" style={{ color: 'var(--hint)' }}>чекає ✅ · {r.where}</div>
              <div className="mt-0.5 text-[14.5px] leading-snug">{r.rule_text}</div>
              {r.source && <div className="mt-1 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>з правки: «{r.source}»</div>}
              <div className="mt-2 flex gap-2">
                <button className="btn" style={{ height: 36, fontSize: 14 }} disabled={busy === r.id} onClick={() => void decide(r, 'approve')}>✅ Схвалити</button>
                <button className="btn sec" style={{ height: 36, fontSize: 14 }} disabled={busy === r.id} onClick={() => void decide(r, 'reject')}>❌ Ні</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data.active.length > 0 && (
        <button className="mx-0.5 mt-2.5 text-[13px]" style={{ color: 'var(--hint)' }} onClick={() => setShowActive(!showActive)}>
          Діють: {data.active.length} {showActive ? '▴' : '▾'}
        </button>
      )}
      {showActive && (
        <div className="card mt-2" style={{ padding: '4px 14px' }}>
          {data.active.map((r, i) => (
            <div key={r.id} className="flex items-start gap-2.5 py-2.5" style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px]" style={{ color: 'var(--hint)' }}>{r.where}</div>
                <div className="mt-0.5 text-[14px] leading-snug">{r.rule_text}</div>
              </div>
              <button className="chip" disabled={busy === r.id} onClick={() => void decide(r, 'disable')}>вимкнути</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

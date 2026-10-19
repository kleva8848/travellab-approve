import type { Plan } from '../lib/api'
import { audienceOf } from '../lib/audience'

// Під постом: тема, для кого (портрет) і на яке питання клієнта відповідає. Пости до 14.10 — без портрета
export function AudienceCard({ plan, compact = false }: { plan: Pick<Plan, 'note' | 'pillar'>; compact?: boolean }) {
  const a = audienceOf(plan)
  if (compact) {
    return (
      <span className="mt-1 block text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>
        🎯 {a.persona ?? 'для всіх'}{a.question ? ` · ❓ ${a.question}` : ''}
      </span>
    )
  }
  return (
    <div className="card mb-3 text-[14px] leading-snug" style={{ boxShadow: 'none', background: 'var(--bg2)' }}>
      <div><span style={{ color: 'var(--hint)' }}>Тема:</span> {a.topic}</div>
      <div className="mt-1">
        <span style={{ color: 'var(--hint)' }}>Для кого:</span>{' '}
        {a.persona ? <><b>{a.persona}</b>{a.who ? <span style={{ color: 'var(--hint)' }}> — {a.who}</span> : null}</> : <span style={{ color: 'var(--hint)' }}>для всіх (відео, «за кадром», історія чи пост до портретів)</span>}
      </div>
      {a.question && <div className="mt-1"><span style={{ color: 'var(--hint)' }}>Відповідає на питання:</span> «{a.question}»</div>}
    </div>
  )
}

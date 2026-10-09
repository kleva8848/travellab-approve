import { useState } from 'react'
import type { Question } from '../lib/api'
import { haptic, openTelegram } from '../lib/tg'

type Props = {
  questions: Question[]
  busy: boolean
  voiceLink?: string | null
  onSubmit: (answers: { id: string; answer: string }[]) => Promise<boolean>
}

// «Бракує даних»: питання агента + поле відповіді на кожне. Відповісти можна частково — решта почекає
export function DataQuestions({ questions, busy, voiceLink, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const filled = questions.filter((q) => (answers[q.id] ?? '').trim())

  const send = async () => {
    const ok = await onSubmit(filled.map((q) => ({ id: q.id, answer: answers[q.id].trim() })))
    if (ok) setAnswers({})
  }

  return (
    <div className="card mb-3">
      <b className="block text-[16px]">Потрібна твоя відповідь</b>
      <div className="mt-1 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
        Агенту бракує {questions.length === 1 ? 'одного факту' : 'кількох фактів'}, щоб написати пост. Відповідь запамʼятаю — більше не питатиму.
      </div>
      {questions.map((q, i) => (
        <div key={q.id} className="mt-4">
          <div className="text-[15px] font-semibold leading-snug">{questions.length > 1 ? `${i + 1}. ` : ''}{q.question}</div>
          {q.why_needed && <div className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>{q.why_needed}</div>}
          <textarea className="in mt-2" rows={2} value={answers[q.id] ?? ''} placeholder="Твоя відповідь"
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
        </div>
      ))}
      <button className="btn mt-4" disabled={busy || !filled.length} onClick={() => void send()}>
        {busy ? 'Надсилаю…' : filled.length && filled.length < questions.length ? 'Надіслати те, що є' : 'Надіслати відповіді'}
      </button>
      {voiceLink && (
        <button className="btn sec mt-2" disabled={busy} onClick={() => { haptic('tap'); openTelegram(voiceLink) }}>
          Відповісти голосом
        </button>
      )}
      {voiceLink && (
        <div className="mt-1.5 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>Відкриється чат з ботом — там одне голосове на всі питання</div>
      )}
    </div>
  )
}

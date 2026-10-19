import { useEffect, useState } from 'react'
import { ApiError, audienceAction, getAudiences, type AudienceAction, type AudienceItem, type AudienceQuestion, type Audiences, type Me } from '../lib/api'
import { haptic } from '../lib/tg'
import { Spinner } from './ui'

// Вкладка «Аудиторії»: для кого пишемо і на які питання клієнтів відповідаємо.
// WF-018 щонеділі бере звідси фокус тижня (активні по черзі) і питання цієї аудиторії. Видалення нема — лише вимкнути
type Edit =
  | { kind: 'audience'; id: string | null; name: string; who: string; match_words: string }
  | { kind: 'question'; id: string | null; audience_id: string; question: string; with_hotel: boolean }

export function AudiencesScreen({ me }: { me: Me }) {
  const [data, setData] = useState<Audiences | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    getAudiences()
      .then((d) => {
        setData(d)
        setOpen(d.next_focus_id)
      })
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 503 ? 'schema_pending' : e instanceof Error ? e.message : String(e)))
  }, [])

  const run = async (a: AudienceAction, done?: string) => {
    setBusy(true)
    try {
      setData(await audienceAction(a))
      setEdit(null)
      haptic('success')
      if (done) {
        setToast(done)
        setTimeout(() => setToast(''), 1800)
      }
    } catch (e) {
      haptic('error')
      setToast(e instanceof Error ? e.message : String(e))
      setTimeout(() => setToast(''), 3000)
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!edit) return
    if (edit.kind === 'audience') {
      void run({ action: 'audience_save', id: edit.id ?? undefined, name: edit.name, who: edit.who, ...(me.is_admin ? { match_words: edit.match_words } : {}) }, 'Збережено')
    } else {
      void run({ action: 'question_save', id: edit.id ?? undefined, audience_id: edit.audience_id, question: edit.question, with_hotel: edit.with_hotel }, 'Збережено')
    }
  }

  if (error === 'schema_pending') {
    return <Shell><div className="card mt-4 text-[14px] leading-snug" style={{ color: 'var(--hint)' }}>Аудиторії ще налаштовуємо — скоро з'являться тут.</div></Shell>
  }
  if (error) return <Shell><div className="card mt-4 text-[14px]" style={{ color: 'var(--bad)' }}>Не вдалося завантажити. {error}</div></Shell>
  if (!data) return <Shell><div className="mt-10 flex justify-center"><Spinner /></div></Shell>

  const next = data.audiences.find((a) => a.id === data.next_focus_id)

  const audienceForm = (e: Extract<Edit, { kind: 'audience' }>) => (
    <div className="mt-2">
      <input className="in mb-2 w-full" style={{ height: 40 }} value={e.name} placeholder="Назва, напр.: Пара з приводом" autoFocus
        onChange={(x) => setEdit({ ...e, name: x.target.value })} />
      <textarea className="in" rows={3} value={e.who} placeholder="Хто ці люди і що їм важливо"
        onChange={(x) => setEdit({ ...e, who: x.target.value })} />
      {me.is_admin && (
        <>
          <div className="mt-2 mb-1 text-[12.5px]" style={{ color: 'var(--hint)' }}>Слова для підбору готелів (теги, who_for, локація), через кому · бачиш лише ти</div>
          <input className="in w-full" style={{ height: 40 }} value={e.match_words} placeholder="couple, romant, пар"
            onChange={(x) => setEdit({ ...e, match_words: x.target.value })} />
        </>
      )}
      <FormButtons busy={busy} ok={Boolean(e.name.trim())} onSave={save} onCancel={() => setEdit(null)} />
    </div>
  )

  const questionForm = (e: Extract<Edit, { kind: 'question' }>) => (
    <div className="py-2.5">
      <textarea className="in" rows={3} value={e.question} placeholder="Як питає клієнт, напр.: Куди поїхати вдвох на ювілей?" autoFocus
        onChange={(x) => setEdit({ ...e, question: x.target.value })} />
      <div className="seg mt-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <button className={e.with_hotel ? 'on' : ''} onClick={() => setEdit({ ...e, with_hotel: true })}>На прикладі готелю</button>
        <button className={!e.with_hotel ? 'on' : ''} onClick={() => setEdit({ ...e, with_hotel: false })}>Загальна тема</button>
      </div>
      <FormButtons busy={busy} ok={Boolean(e.question.trim())} onSave={save} onCancel={() => setEdit(null)} />
    </div>
  )

  const questionRow = (q: AudienceQuestion, i: number) => {
    if (edit?.kind === 'question' && edit.id === q.id) return <div key={q.id} style={{ borderTop: i ? '.5px solid var(--line)' : 0 }}>{questionForm(edit)}</div>
    return (
      <div key={q.id} className="flex items-start gap-2.5 py-2.5" style={{ borderTop: i ? '.5px solid var(--line)' : 0, opacity: q.active ? 1 : 0.5 }}>
        <button className="min-w-0 flex-1 text-left" disabled={busy}
          onClick={() => { haptic('tap'); setEdit({ kind: 'question', id: q.id, audience_id: q.audience_id, question: q.question, with_hotel: q.with_hotel }) }}>
          <div className="text-[14px] leading-snug">{q.question}</div>
          <div className="mt-0.5 text-[12px]" style={{ color: 'var(--hint)' }}>
            {q.with_hotel ? 'на прикладі готелю' : 'загальна тема'}{q.active ? '' : ' · вимкнено'}
          </div>
        </button>
        <button className="chip" disabled={busy} onClick={() => void run({ action: 'question_active', id: q.id, active: !q.active })}>
          {q.active ? 'вимкнути' : 'увімкнути'}
        </button>
      </div>
    )
  }

  const card = (a: AudienceItem) => {
    const expanded = open === a.id
    const on = a.questions.filter((q) => q.active).length
    const editing = edit?.kind === 'audience' && edit.id === a.id
    return (
      <div key={a.id} className="card mt-2.5" style={{ opacity: a.active ? 1 : 0.6 }}>
        {editing ? audienceForm(edit) : (
          <button className="block w-full text-left" onClick={() => { haptic('tap'); setOpen(expanded ? null : a.id) }}>
            <span className="flex flex-wrap items-center gap-1.5">
              <b className="text-[15.5px]">{a.name}</b>
              {a.id === data.next_focus_id && <span className="chip okc">наступний тиждень</span>}
              {!a.active && <span className="chip">вимкнена</span>}
            </span>
            {a.who && <span className="mt-1 block text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>{a.who}</span>}
            <span className="mt-1.5 block text-[12.5px]" style={{ color: 'var(--hint)' }}>Питань: {on}{a.questions.length > on ? ` (+${a.questions.length - on} вимк.)` : ''} {expanded ? '▴' : '▾'}</span>
          </button>
        )}
        {expanded && !editing && (
          <>
            <div className="mt-2" style={{ borderTop: '.5px solid var(--line)' }}>
              {a.questions.map(questionRow)}
              {edit?.kind === 'question' && !edit.id && edit.audience_id === a.id && (
                <div style={{ borderTop: a.questions.length ? '.5px solid var(--line)' : 0 }}>{questionForm(edit)}</div>
              )}
            </div>
            {!(edit?.kind === 'question' && !edit.id && edit.audience_id === a.id) && (
              <div className="mt-1 flex flex-wrap gap-2">
                <button className="chip" disabled={busy} onClick={() => setEdit({ kind: 'question', id: null, audience_id: a.id, question: '', with_hotel: true })}>+ Питання</button>
                <button className="chip" disabled={busy} onClick={() => setEdit({ kind: 'audience', id: a.id, name: a.name, who: a.who, match_words: a.match_words })}>Редагувати</button>
                <button className="chip" disabled={busy} onClick={() => void run({ action: 'audience_active', id: a.id, active: !a.active }, a.active ? 'Вимкнено — агент її пропускатиме' : 'Увімкнено')}>
                  {a.active ? 'Вимкнути аудиторію' : 'Увімкнути аудиторію'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const adding = edit?.kind === 'audience' && !edit.id
  return (
    <Shell>
      <div className="mx-0.5 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
        Щотижня агент пише для однієї аудиторії — по черзі. Питання — те, що реально питають клієнти: пости відповідають на них.
      </div>
      {next && (
        <div className="card mt-3 text-[14px] leading-snug" style={{ boxShadow: 'none', background: 'var(--bg2)' }}>
          🎯 Наступний тиждень: <b>{next.name}</b>
          <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--hint)' }}>План складається в неділю ввечері — зміни до того часу потраплять у нього.</div>
        </div>
      )}
      {data.audiences.map(card)}
      {adding ? (
        <div className="card mt-2.5">{audienceForm(edit)}</div>
      ) : (
        <button className="btn sec mt-3" disabled={busy} onClick={() => setEdit({ kind: 'audience', id: null, name: '', who: '', match_words: '' })}>+ Нова аудиторія</button>
      )}
      {toast && <div className="toast">{toast}</div>}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-3.5 pb-6">
      <h1 className="serif mt-1.5 mb-3 text-[28px]">Аудиторії</h1>
      {children}
    </div>
  )
}

function FormButtons({ busy, ok, onSave, onCancel }: { busy: boolean; ok: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="mt-2 flex gap-2">
      <button className="btn" style={{ height: 38, fontSize: 14 }} disabled={busy || !ok} onClick={onSave}>Зберегти</button>
      <button className="btn sec" style={{ height: 38, fontSize: 14 }} disabled={busy} onClick={onCancel}>Скасувати</button>
    </div>
  )
}

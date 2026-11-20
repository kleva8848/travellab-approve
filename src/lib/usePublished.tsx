import { useCallback, useRef, useState } from 'react'
import { reviewAction } from './api'
import { haptic } from './tg'

type Target = { id: string; version_no?: number }
type Ops = { pub: (t: Target) => Promise<unknown>; unpub: (t: Target) => Promise<unknown> }
const postOps: Ops = {
  pub: (t) => reviewAction(t.id, t.version_no ?? 0, 'publish'),
  unpub: (t) => reviewAction(t.id, t.version_no ?? 0, 'unpublish'),
}

// «✓ Виклала» одним тапом: пост одразу зникає зі списку, внизу 5 с висить «Скасувати»
export function usePublished(onChanged: () => void, ops: Ops = postOps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ text: string; undo?: Target } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = useCallback((t: { text: string; undo?: Target } | null, ms = 5000) => {
    clearTimeout(timer.current)
    setToast(t)
    if (t) timer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const setHide = (id: string, on: boolean) =>
    setHidden((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  const mark = async (q: Target) => {
    haptic('success')
    setHide(q.id, true)
    show({ text: 'Позначила: викладено ✓', undo: q })
    try {
      await ops.pub(q)
    } catch (e) {
      setHide(q.id, false)
      haptic('error')
      show({ text: e instanceof Error ? e.message : 'Помилка' }, 2500)
    }
    onChanged()
  }

  const undo = async () => {
    const q = toast?.undo
    if (!q) return
    show(null)
    try {
      await ops.unpub(q)
      haptic('tap')
    } catch (e) {
      show({ text: e instanceof Error ? e.message : 'Помилка' }, 2500)
    }
    setHide(q.id, false)
    onChanged()
  }

  const node = toast ? (
    <div className="toast" style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span>{toast.text}</span>
      {toast.undo && <button className="underline" style={{ fontWeight: 600 }} onClick={() => void undo()}>Скасувати</button>}
    </div>
  ) : null

  return { hidden, mark, node }
}

// Маленька кнопка «✓ Виклала» для картки (stopPropagation — не відкриває пост)
export function PublishedButton({ onClick }: { onClick: () => void }) {
  return (
    <span
      role="button"
      className="btn sec"
      style={{ width: 'auto', height: 34, padding: '0 10px', fontSize: 13, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      ✓ Виклала
    </span>
  )
}

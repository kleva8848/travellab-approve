import { useEffect, useState } from 'react'
import { reviewAction } from '../lib/api'
import { haptic } from '../lib/tg'

// «💬 Написали з цього поста»: тап = +1 звернення, «−1» знімає останнє (без діалогів). Лише для викладених постів
export function Inquiries({ id, versionNo, count, onChanged }: { id: string; versionNo: number; count: number; onChanged?: () => void }) {
  const [n, setN] = useState(count)
  const [busy, setBusy] = useState(false)
  useEffect(() => setN(count), [count])

  const tap = async (on: boolean) => {
    setBusy(true)
    try {
      const r = await reviewAction(id, versionNo, 'inquiry', { on })
      setN(r.inquiries ?? Math.max(0, n + (on ? 1 : -1)))
      haptic(on ? 'success' : 'tap')
      onChanged?.()
    } catch {
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button className={`chip ${n ? 'okc' : ''}`} disabled={busy} onClick={() => void tap(true)}>
        💬 Написали{n ? ` · ${n}` : ''}
      </button>
      {n > 0 && <button className="chip" disabled={busy} onClick={() => void tap(false)} aria-label="Зняти останнє">−1</button>}
    </span>
  )
}

import type { ReactNode } from 'react'

// **жирний** з генератора → <b>; решта — як є (React сам екранує)
export function renderPost(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : part,
  )
}

export type DiffPart = { kind: 'same' | 'ins' | 'del'; text: string }

// Різниця по словах (LCS). Пробіли й переноси — окремі токени, щоб абзаци не злипались
export function diffWords(a: string, b: string): DiffPart[] {
  const tok = (s: string) => s.replace(/\*\*/g, '').match(/\s+|[^\s]+/g) ?? []
  const x = tok(a)
  const y = tok(b)
  // Захист від дуже довгих текстів: LCS O(n·m) — пости до ~2k символів, це ~400×400
  if (x.length * y.length > 400_000) return [{ kind: 'same', text: b }]
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++])
    else push('ins', y[j++])
  }
  while (i < x.length) push('del', x[i++])
  while (j < y.length) push('ins', y[j++])
  // Пробіл-«острівці» між двома змінами не підсвічуємо окремо — читається спокійніше
  return out
}

export function renderDiff(parts: DiffPart[]): ReactNode[] {
  return parts.map((p, i) =>
    p.kind === 'same' ? p.text : p.kind === 'ins' ? <ins key={i}>{p.text}</ins> : p.text.trim() ? <del key={i}>{p.text}</del> : null,
  )
}

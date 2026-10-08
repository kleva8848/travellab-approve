import type { ReactNode } from 'react'

export function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center px-8 text-center">{children}</div>
}

export function Spinner() {
  return (
    <div
      className="h-7 w-7 animate-spin rounded-full border-[3px]"
      style={{ borderColor: 'color-mix(in srgb, var(--hint) 30%, transparent)', borderTopColor: 'var(--text)' }}
    />
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="mx-0.5 mt-5 mb-2 text-[12px] tracking-[.06em] uppercase" style={{ color: 'var(--hint)' }}>{children}</div>
}

export const IconSun = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

export const IconCalendar = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
)

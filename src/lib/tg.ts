import { useEffect, useRef } from 'react'

type HapticStyle = 'light' | 'medium' | 'heavy'

type WebApp = {
  initData: string
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string } }
  version: string
  colorScheme?: 'light' | 'dark'
  ready(): void
  expand(): void
  isVersionAtLeast?(v: string): boolean
  disableVerticalSwipes?(): void
  setHeaderColor?(c: string): void
  setBackgroundColor?(c: string): void
  onEvent?(e: 'themeChanged', cb: () => void): void
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
  HapticFeedback?: {
    impactOccurred(s: HapticStyle): void
    notificationOccurred(t: 'success' | 'error' | 'warning'): void
    selectionChanged(): void
  }
  showConfirm?(msg: string, cb: (ok: boolean) => void): void
  openLink?(url: string): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp }
  }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp

export const isDemo = new URLSearchParams(location.search).has('demo')
export const inTelegram = Boolean(tg?.initData)
const atLeast = (v: string) => Boolean(inTelegram && tg?.isVersionAtLeast?.(v))

// Deep link t.me/<bot>?startapp=<param> (у демо: ?startapp=...). Фаза 3: post_<id>, фаза 4: questions
export function startParam(): string {
  return tg?.initDataUnsafe?.start_param ?? new URLSearchParams(location.search).get('startapp') ?? ''
}

// Тема апки = тема Telegram (світла/темна), кольори — свої брендові, не з теми Telegram
function applyTheme() {
  const scheme = tg?.colorScheme
  if (!inTelegram || !scheme) return
  document.documentElement.dataset.theme = scheme
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (atLeast('6.1') && bg) {
    tg?.setHeaderColor?.(bg)
    tg?.setBackgroundColor?.(bg)
  }
}

export function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand()
  // Щоб апка не закривалась випадковим свайпом вниз під час прокрутки
  if (atLeast('7.7')) tg.disableVerticalSwipes?.()
  applyTheme()
  tg.onEvent?.('themeChanged', applyTheme)
}

export function firstName(): string | null {
  return tg?.initDataUnsafe?.user?.first_name ?? null
}

export function haptic(kind: 'tap' | 'select' | 'press' | 'success' | 'error' | 'warning' = 'tap') {
  const h = inTelegram ? tg?.HapticFeedback : undefined
  if (!h) return
  if (kind === 'tap') h.impactOccurred('light')
  else if (kind === 'select') h.selectionChanged()
  else if (kind === 'press') h.impactOccurred('medium')
  else h.notificationOccurred(kind)
}

export function openExternal(url: string) {
  if (inTelegram && tg?.openLink) tg.openLink(url)
  else window.open(url, '_blank', 'noopener')
}

export function confirmAction(message: string): Promise<boolean> {
  if (atLeast('6.2') && tg?.showConfirm) return new Promise((r) => tg!.showConfirm!(message, r))
  return Promise.resolve(window.confirm(message))
}

// Кнопка «Назад» Telegram закриває відкритий екран (поки він відкритий)
export function useBackButton(active: boolean, onBack: () => void) {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    const bb = atLeast('6.1') ? tg?.BackButton : undefined
    if (!active || !bb) return
    const handler = () => ref.current()
    bb.show()
    bb.onClick(handler)
    return () => {
      bb.offClick(handler)
      bb.hide()
    }
  }, [active])
}

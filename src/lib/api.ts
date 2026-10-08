import { isDemo, tg } from './tg'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const TIMEOUT_MS = 15_000

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${tg?.initData ?? ''}`, ...init?.headers },
    })
  } catch {
    throw new ApiError(0, 'Немає звʼязку з сервером. Перевір інтернет і спробуй ще раз.')
  } finally {
    clearTimeout(timer)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.tg_id ? `TG ID ${body.tg_id}` : body.error ?? res.statusText)
  return body as T
}

export type Me = { id: number; first_name?: string; username?: string; is_admin: boolean }

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

export async function getMe(): Promise<Me> {
  if (isDemo) {
    await wait()
    return { id: 1, first_name: 'Іра', is_admin: false }
  }
  const r = await call<{ user: Me }>('/api/me')
  return r.user
}

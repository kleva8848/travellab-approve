import { db, getSettings } from './http.js'

export type StoryInfo = { link: string; hint: string; queued: number }

// «🎙 Розповісти історію» на головній: deep link у бот (/start story → бот ставить підказку і чекає голосове),
// питання-підказка тижня і скільки історій уже в черзі. Та сама логіка підказки, що в n8n/story_prompt.mjs (бот, дайджест):
// портрет тижня, у який піде історія (план WF-018 — на найближчий понеділок), питання з settings.story_prompts по колу.
// Голос через бот вимкнено (settings.voice_answers ≠ on) → картки нема.
export async function storyInfo(): Promise<StoryInfo | null> {
  const s = await getSettings(['voice_answers', 'bot_username', 'story_prompts'])
  const on = s.voice_answers === 'on' || s.voice_answers === true
  const bot = typeof s.bot_username === 'string' ? s.bot_username.replace(/^@/, '') : ''
  if (!on || !bot) return null
  const q = await db().from('story_queue').select('id', { count: 'exact', head: true }).eq('status', 'new')
  return { link: `https://t.me/${bot}?start=story`, hint: storyHint(s.story_prompts), queued: q.error ? 0 : q.count ?? 0 }
}

const PERSONAS = ['P1', 'P2', 'P3', 'P4']

function storyHint(bank: unknown): string {
  const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const today = new Date(kyiv + 'T00:00:00Z')
  const dow = (today.getUTCDay() + 6) % 7
  const weekStart = new Date(today.getTime() + (dow === 0 ? 0 : 7 - dow) * 86400000)
  const thu = new Date(weekStart.getTime() + 3 * 86400000)
  const week = 1 + Math.floor((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000))
  const persona = PERSONAS[week % PERSONAS.length]
  const list = (Array.isArray(bank) ? bank : []) as { p?: string; q?: string }[]
  const mine = list.filter((x) => x && x.q && (!x.p || x.p === persona))
  return mine.length
    ? String(mine[Math.floor(week / PERSONAS.length) % mine.length].q)
    : 'Яка історія з поїздок — твоїх чи клієнтів — запамʼяталась останнім часом?'
}

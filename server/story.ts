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
  const [q, a] = await Promise.all([
    db().from('story_queue').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    db().from('audiences').select('code, name, active, sort_order'),
  ])
  // SQL 017 ще нема → a.error → P1–P4 з коду
  const aud = a.error ? [] : ((a.data ?? []) as Aud[])
  return { link: `https://t.me/${bot}?start=story`, hint: storyHint(s.story_prompts, aud), queued: q.error ? 0 : q.count ?? 0 }
}

type Aud = { code: string; name: string; active: boolean; sort_order: number }

// Аудиторія тижня — активні з audiences по колу (як WF-018); без підказок у банку — питання з назви аудиторії
function storyHint(bank: unknown, aud: Aud[]): string {
  const on = aud.filter((x) => x.code && x.active !== false).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0) || x.code.localeCompare(y.code))
  const PERSONAS = on.length ? on.map((x) => x.code) : ['P1', 'P2', 'P3', 'P4']
  const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const today = new Date(kyiv + 'T00:00:00Z')
  const dow = (today.getUTCDay() + 6) % 7
  const weekStart = new Date(today.getTime() + (dow === 0 ? 0 : 7 - dow) * 86400000)
  const thu = new Date(weekStart.getTime() + 3 * 86400000)
  const week = 1 + Math.floor((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000))
  const persona = PERSONAS[week % PERSONAS.length]
  const all = ((Array.isArray(bank) ? bank : []) as { p?: string; q?: string }[]).filter((x) => x && x.q)
  const mine = all.filter((x) => x.p === persona)
  const list = mine.length ? mine : all.filter((x) => !x.p)
  const a = on.find((x) => x.code === persona)
  if (list.length) return String(list[Math.floor(week / PERSONAS.length) % list.length].q)
  return a
    ? `Згадай клієнтів, схожих на «${a.name}». Що їм запамʼяталось найбільше — і чого вони не очікували?`
    : 'Яка історія з поїздок — твоїх чи клієнтів — запамʼяталась останнім часом?'
}

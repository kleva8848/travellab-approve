// «🎙 Розповісти історію»: питання-підказка тижня. Спільне для бота (build_voice_answers.mjs) і дайджесту (build_reminders.mjs);
// у апці — та сама логіка в server/story.ts. Банк питань — settings.story_prompts (supabase/016_story_prompts.sql), Іра/Влад
// можуть міняти без деплою. Підказка — під портрет тижня, у який піде історія: WF-018 складає план у неділю на НАСТУПНИЙ
// тиждень, тож беремо портрет найближчого понеділка (у понеділок — поточного) — та сама формула, що в build_weekly_plan.mjs.

// 19.10: аудиторії — з таблиці audiences (вкладка «Аудиторії», SQL 017): активні за sort_order по колу, як у WF-018.
// Порожньо / таблиці нема → P1–P4 з коду. Для аудиторії без підказок у банку — питання з її назви.
// Код для n8n Code-вузла: потрібні змінні `s` (settings key → value) і `aud` (рядки audiences, можна []) у тому ж скоупі;
// дає storyHint() → { persona, hint }
export const STORY_HINT_JS = String.raw`const storyHint = () => {
  const on = (Array.isArray(aud) ? aud : []).filter(a => a && a.code && a.active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.code).localeCompare(String(b.code)));
  const PERSONAS = on.length ? on.map(a => a.code) : ['P1', 'P2', 'P3', 'P4'];
  const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = new Date(kyiv + 'T00:00:00Z');
  const dow = (today.getUTCDay() + 6) % 7;
  const weekStart = new Date(today.getTime() + ((dow === 0 ? 0 : 7 - dow) * 86400000));
  const thu = new Date(weekStart.getTime() + 3 * 86400000);
  const WEEK = 1 + Math.floor((thu - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000));
  const persona = PERSONAS[WEEK % PERSONAS.length];
  const a = on.find(x => x.code === persona);
  let bank = s.story_prompts;
  if (typeof bank === 'string') { try { bank = JSON.parse(bank); } catch (e) { bank = null; } }
  const mine = (Array.isArray(bank) ? bank : []).filter(x => x && x.q && x.p === persona);
  const any = (Array.isArray(bank) ? bank : []).filter(x => x && x.q && !x.p);
  const list = mine.length ? mine : any;
  const hint = list.length ? list[Math.floor(WEEK / PERSONAS.length) % list.length].q
    : a ? 'Згадай клієнтів, схожих на «' + a.name + '». Що їм запамʼяталось найбільше — і чого вони не очікували?'
    : 'Яка історія з поїздок — твоїх чи клієнтів — запамʼяталась останнім часом?';
  return { persona, hint };
};`

// Прихований маркер у повідомленні бота «розкажи історію»: голосове у відповідь на нього = історія (не відповідь на питання поста)
export const STORY_MARK_RE = String.raw`/[?&]start(?:app)?=story\b/i`

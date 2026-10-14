// «🎙 Розповісти історію»: питання-підказка тижня. Спільне для бота (build_voice_answers.mjs) і дайджесту (build_reminders.mjs);
// у апці — та сама логіка в server/story.ts. Банк питань — settings.story_prompts (supabase/016_story_prompts.sql), Іра/Влад
// можуть міняти без деплою. Підказка — під портрет тижня, у який піде історія: WF-018 складає план у неділю на НАСТУПНИЙ
// тиждень, тож беремо портрет найближчого понеділка (у понеділок — поточного) — та сама формула, що в build_weekly_plan.mjs.

// Код для n8n Code-вузла: потрібна змінна `s` (settings key → value) у тому ж скоупі; дає storyHint() → { persona, hint }
export const STORY_HINT_JS = String.raw`const storyHint = () => {
  const PERSONAS = ['P1', 'P2', 'P3', 'P4'];
  const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = new Date(kyiv + 'T00:00:00Z');
  const dow = (today.getUTCDay() + 6) % 7;
  const weekStart = new Date(today.getTime() + ((dow === 0 ? 0 : 7 - dow) * 86400000));
  const thu = new Date(weekStart.getTime() + 3 * 86400000);
  const WEEK = 1 + Math.floor((thu - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000));
  const persona = PERSONAS[WEEK % PERSONAS.length];
  let bank = s.story_prompts;
  if (typeof bank === 'string') { try { bank = JSON.parse(bank); } catch (e) { bank = null; } }
  const mine = (Array.isArray(bank) ? bank : []).filter(x => x && x.q && (!x.p || x.p === persona));
  const hint = mine.length ? mine[Math.floor(WEEK / PERSONAS.length) % mine.length].q : 'Яка історія з поїздок — твоїх чи клієнтів — запамʼяталась останнім часом?';
  return { persona, hint };
};`

// Прихований маркер у повідомленні бота «розкажи історію»: голосове у відповідь на нього = історія (не відповідь на питання поста)
export const STORY_MARK_RE = String.raw`/[?&]start(?:app)?=story\b/i`

// node n8n/build_weekly_plan.mjs [dump|update <id>]
// WF-018 «[TravelLab] Крок 7 Stage 1 - Weekly Slot Plan» (прод SwVveOJhn4qSbEwn): patch-білдер.
// Джерело — знімок n8n/weekly_plan.json (живий WF до правок; історія в git). Міняємо ЛИШЕ Code-вузол плану,
// решта (Schedule, Webhook з Header Auth, Supabase, Telegram-звіт, позначки Assigned/used) — як є.
//
// #7 роадмапу (§27): (а) ліміт оферів, (б) рубрика «Незвичайні готелі» (unusual_hotels, карусель TG+IG).
// Ліміт — з Audience_Strategy_v2 §2.3: TG ~70% користь / ~20% м'яка рекомендація / ~10% прямий офер.
// 5 TG-постів на тиждень → прямий офер ≤ 1 (=20%, найближче ціле до 10%); IG — той самий тур ≤ 1 (Чт).
// Іра ще відповідає на «скільки прямих пропозицій на тиждень комфортно (1? 2?)» → OFFERS_PER_WEEK.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLAN_NODE = 'Code - Build Weekly Slot Plan'

export const PLAN_CODE = String.raw`// WF-018 — план тижня. Джерело правди: n8n/build_weekly_plan.mjs (репо travellab-approve)
const OFFERS_PER_WEEK = 1; // прямих оферів на платформу (TG, IG); Threads — без продажу

const rows = (n) => $(n).all().map(i => i.json).filter(j => Object.keys(j).length > 0);
const tours = rows('Supabase - Get Ready Tours');
const hotels = rows('Supabase - Get Ready Hotels');
const stories = rows('Supabase - Get New Stories');

tours.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
stories.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

// ISO-тиждень — для ротації готелів (щоб не той самий готель щотижня)
const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() + 3 - ((d0.getDay() + 6) % 7));
const w1 = new Date(d0.getFullYear(), 0, 4);
const WEEK = 1 + Math.round(((d0 - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
const rotate = (arr) => arr.length ? arr.slice(WEEK % arr.length).concat(arr.slice(0, WEEK % arr.length)) : arr;

// ── Офер: лише найстаріший готовий тур (≤ OFFERS_PER_WEEK). Решта турів чекає наступних тижнів.
const offerTours = tours.slice(0, OFFERS_PER_WEEK);
const offerTour = offerTours[0] || null;
const used = new Set(offerTours.map(t => t.hotel_id).filter(Boolean));

// ── «Незвичайні готелі»: детермінований критерій
// 1) тег 'unusual' / 'незвичайний' у hotels.tags (явна позначка) — пріоритет;
// 2) або маркер у key_detail (поле Іри) / type: перший·єдиний, підводний, над водою/океаном, tree-house,
//    нестандартний/незвичайний, глемпінг, еко-лодж, печера, маяк, замок.
// Обов'язково key_detail і who_for (як у pre-gate), готель не зайнятий цього тижня. Ротація — за ISO-тижнем.
const UNUSUAL_TAG = /^(unusual|незвичайн)/i;
const UNUSUAL_TEXT = /перш(ий|а|е)\s|єдин|підводн|над\s+(водою|океаном|морем)|tree-?house|на\s+дерев|нестандартн|незвичайн|unusual|глемпінг|glamping|lodge|лодж|печер|\bcave|маяк|lighthouse|замок|castle/i;
const ready = (h) => !!(h && h.hotel_id && String(h.key_detail || '').trim() && String(h.who_for || '').trim());
const tagged = (h) => (Array.isArray(h.tags) ? h.tags : []).some(t => UNUSUAL_TAG.test(String(t)));
const marked = (h) => UNUSUAL_TEXT.test(String(h.key_detail || '')) || UNUSUAL_TEXT.test(String(h.type || ''));
const byId = (a, b) => String(a.hotel_id).localeCompare(String(b.hotel_id));
const free = hotels.filter(h => ready(h) && !used.has(h.hotel_id));
const unusualPool = free.filter(tagged).sort(byId).length ? free.filter(tagged).sort(byId) : free.filter(marked).sort(byId);
const unusualHotel = unusualPool.length ? unusualPool[WEEK % unusualPool.length] : null;
if (unusualHotel) used.add(unusualHotel.hotel_id);

// ── Готелі для контент-слотів (замість зайвих оферів): вільні, з ротацією за тижнем
let pool = rotate(hotels.filter(h => h.hotel_id && !used.has(h.hotel_id)).sort(byId));
const nextHotel = () => { const h = pool.shift() || null; if (h) used.add(h.hotel_id); return h ? h.hotel_id : null; };

const pickedStory = stories.length > 0 ? stories[0] : null;
const slots = [];
const S = (o) => slots.push(Object.assign({ tour_id: null, hotel_id: null, story_id: null, pair_key: null }, o));

// Пара A (Пн): був тур-офер → тепер м'яка рекомендація «про готель», без ціни
const hA = nextHotel();
S({ day: 'Пн', platform: 'telegram', slot_type: 'content', pillar: 'hotel_place', hotel_id: hA, pair_key: 'A' });
S({ day: 'Пн', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'hotel_place', hotel_id: hA, pair_key: 'A' });
S({ day: 'Пн', platform: 'threads', slot_type: 'expert_take', pillar: 'tour_expert', hotel_id: hA, pair_key: 'A', note: "мінімальна прив'язка до готелю, авторитетний тон, не продаж" });

// Ср: інсайдер (самостійний готель) + IG сторіз + Threads думка
S({ day: 'Ср', platform: 'telegram', slot_type: 'content', pillar: 'insider', hotel_id: nextHotel() });
S({ day: 'Ср', platform: 'instagram', slot_type: 'stories', pillar: 'behind_scenes', note: 'live від Іри' });
S({ day: 'Ср', platform: 'threads', slot_type: 'personal_thought', pillar: 'personal_take', note: "власна думка/експертиза Іри, без прив'язки до туру чи готелю" });

// Пара B (Чт IG / Пт TG): єдиний прямий офер тижня — найстаріший тур; немає туру → інсайдер про готель
if (offerTour) {
  S({ day: 'Пт', platform: 'telegram', slot_type: 'offer', pillar: 'tour_offer', tour_id: offerTour.tour_id, hotel_id: offerTour.hotel_id, pair_key: 'B' });
  S({ day: 'Чт', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'tour_offer', tour_id: offerTour.tour_id, hotel_id: offerTour.hotel_id, pair_key: 'B' });
} else {
  const hB = nextHotel();
  S({ day: 'Пт', platform: 'telegram', slot_type: 'content', pillar: 'insider', hotel_id: hB, pair_key: 'B', note: 'турів у черзі нема — замість офера' });
  S({ day: 'Чт', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'hotel_place', hotel_id: hB, pair_key: 'B', note: 'турів у черзі нема — замість офера' });
}

// Пара D (Сб TG / Пт IG / Пт Threads): особиста історія з черги; немає → інсайдер про готель (раніше — 4-й тур-офер)
if (pickedStory) {
  S({ day: 'Сб', platform: 'telegram', slot_type: 'content', pillar: pickedStory.pillar, hotel_id: pickedStory.hotel_id || null, story_id: pickedStory.id, pair_key: 'D' });
} else {
  S({ day: 'Сб', platform: 'telegram', slot_type: 'content', pillar: 'insider', hotel_id: nextHotel(), pair_key: 'D' });
}
const sat = slots[slots.length - 1];
S({ day: 'Пт', platform: 'instagram', slot_type: 'reel_or_feed', pillar: 'personal', hotel_id: sat.hotel_id, story_id: sat.story_id, pair_key: 'D' });
S({ day: 'Пт', platform: 'threads', slot_type: 'personal_thought', pillar: sat.story_id ? sat.pillar : 'personal_take', story_id: sat.story_id || null, pair_key: 'D', note: 'особиста історія Іри в авторитетному форматі, якщо є в черзі; інакше самостійна думка' });

// Пара C (Нд): рубрика «Незвичайні готелі» — карусель TG + IG, 1/тиждень, якщо є кандидат;
// інакше — атмосфера про готель (раніше — сезонний тур-офер)
if (unusualHotel) {
  const note = 'рубрика «Незвичайні готелі», карусель: чим саме цей готель не схожий на інші (з key_detail)';
  S({ day: 'Нд', platform: 'telegram', slot_type: 'feed_carousel', pillar: 'unusual_hotels', hotel_id: unusualHotel.hotel_id, pair_key: 'C', note });
  S({ day: 'Нд', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'unusual_hotels', hotel_id: unusualHotel.hotel_id, pair_key: 'C', note });
} else {
  const hC = nextHotel();
  S({ day: 'Нд', platform: 'telegram', slot_type: 'content', pillar: 'atmosphere', hotel_id: hC, pair_key: 'C' });
  S({ day: 'Нд', platform: 'instagram', slot_type: 'feed', pillar: 'atmosphere', hotel_id: hC, pair_key: 'C' });
}

// IG без прив'язки до черги
S({ day: 'Вт', platform: 'instagram', slot_type: 'reel', pillar: 'video', note: 'джерело — відео з media, тур не потрібен' });
S({ day: 'Сб', platform: 'instagram', slot_type: 'stories', pillar: 'template', note: 'шаблон агента, тема тижня' });

return slots.map(s => ({ json: s }));`

const wf = JSON.parse(readFileSync(join(here, 'weekly_plan.json'), 'utf8'))
const plan = wf.nodes.find((n) => n.name === PLAN_NODE)
if (!plan) throw new Error('нема вузла ' + PLAN_NODE)
plan.parameters.jsCode = PLAN_CODE
const out = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings }

// імпорт з тестового харнеса (PLAN_CODE) — без CLI-дій
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const mode = isMain ? process.argv[2] || 'dump' : 'import'
if (mode === 'import') {
  // нічого
} else if (mode === 'dump') {
  writeFileSync(join(here, 'weekly_plan.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('dumped', out.nodes.length, 'nodes → n8n/weekly_plan.json')
} else if (mode === 'update') {
  const id = process.argv[3]
  if (!id) throw new Error('update <id>')
  const mcp = JSON.parse(readFileSync(join(here, '..', '..', '..', '.mcp.json'), 'utf8'))
  const env = (mcp.mcpServers || mcp)['n8n-mcp'].env
  const base = env.N8N_API_URL.replace(/\/$/, '')
  const api = base.endsWith('/api/v1') ? base : base + '/api/v1'
  const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' }
  const r = await fetch(`${api}/workflows/${id}`, { method: 'PUT', headers, body: JSON.stringify(out) })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch {}
  console.log(r.status, j && j.id ? `${j.id} ${j.name} active=${j.active}` : t.slice(0, 500))
} else {
  throw new Error('режим: dump | update <id>')
}

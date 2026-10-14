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

// Дата — за Києвом. Тиждень плану: у понеділок — поточний, в інші дні (розклад у неділю, ручний запуск) — наступний.
const kyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = new Date(kyiv + 'T00:00:00Z');
const dow = (today.getUTCDay() + 6) % 7; // 0 = Пн
const weekStart = new Date(today.getTime() + ((dow === 0 ? 0 : 7 - dow) * 86400000));
const ymd = (d) => d.toISOString().slice(0, 10);
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const WEEK_START = ymd(weekStart);
const dateOf = (day) => ymd(new Date(weekStart.getTime() + DAYS.indexOf(day) * 86400000));
// ISO-номер тижня плану — для ротації готелів (щоб не той самий готель щотижня)
const thu = new Date(weekStart.getTime() + 3 * 86400000);
const WEEK = 1 + Math.floor((thu - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000));

// ── Офер: лише найстаріший готовий тур (≤ OFFERS_PER_WEEK). Решта турів чекає наступних тижнів.
const offerTours = tours.slice(0, OFFERS_PER_WEEK);
const offerTour = offerTours[0] || null;
const used = new Set(offerTours.map(t => t.hotel_id).filter(Boolean));

const byId = (a, b) => String(a.hotel_id).localeCompare(String(b.hotel_id));
const rotate = (arr) => arr.length ? arr.slice(WEEK % arr.length).concat(arr.slice(0, WEEK % arr.length)) : arr;
// Немає туру → готель з ціною «від … за ніч» (колонки може не бути — тоді просто не офер)
const priceHotel = offerTour ? null : (rotate(hotels.filter(h => h.hotel_id && Number(h.price_from_night) > 0).sort(byId))[0] || null);
if (priceHotel) used.add(priceHotel.hotel_id);

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

// Пара B (Чт IG / Пт TG): єдиний прямий офер тижня — найстаріший тур;
// турів нема → офер на готель з відомою ціною (hotels.price_from_night, SQL 007); нема й такого → інсайдер про готель
if (offerTour) {
  S({ day: 'Пт', platform: 'telegram', slot_type: 'offer', pillar: 'tour_offer', tour_id: offerTour.tour_id, hotel_id: offerTour.hotel_id, pair_key: 'B' });
  S({ day: 'Чт', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'tour_offer', tour_id: offerTour.tour_id, hotel_id: offerTour.hotel_id, pair_key: 'B' });
} else if (priceHotel) {
  const note = 'офер на готель: турів у черзі нема, ціна — hotels.price_from_night';
  S({ day: 'Пт', platform: 'telegram', slot_type: 'offer', pillar: 'tour_offer', hotel_id: priceHotel.hotel_id, pair_key: 'B', note });
  S({ day: 'Чт', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'tour_offer', hotel_id: priceHotel.hotel_id, pair_key: 'B', note });
} else {
  const hB = nextHotel();
  S({ day: 'Пт', platform: 'telegram', slot_type: 'content', pillar: 'insider', hotel_id: hB, pair_key: 'B', note: 'турів і цін у черзі нема — замість офера' });
  S({ day: 'Чт', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'hotel_place', hotel_id: hB, pair_key: 'B', note: 'турів і цін у черзі нема — замість офера' });
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

// Дата слоту для апки / Buffer Filler (WF-051) і стан огляду
// + назви готелю/туру — лише для звіту в TG (у content_plan не пишуться)
const hotelName = (id) => { const h = hotels.find(x => x.hotel_id === id); return h ? (h.name || id) : null; };
const tourTitle = (id) => { const t = tours.find(x => x.tour_id === id); return t ? (t.title || id) : null; };
return slots.map(s => ({ json: Object.assign(s, {
  week_start: WEEK_START, scheduled_for: dateOf(s.day), review_status: 'planned',
  hotel_name: s.hotel_id ? hotelName(s.hotel_id) : null, tour_title: s.tour_id ? tourTitle(s.tour_id) : null,
}) }));`

// Звіт Владу в TG: по днях, з датами і назвами готелів, людською мовою
export const REPORT_CODE = String.raw`const items = $input.all().map(i => i.json);
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const PLAT = { telegram: 'TG', instagram: 'IG', threads: 'Threads' };
const PORDER = ['telegram', 'instagram', 'threads'];
const KIND = { content: 'пост', feed: 'пост', feed_carousel: 'карусель', offer: 'пост з ціною', reel: 'рілс', stories: 'сторіз',
  reel_or_feed: 'рілс або пост', expert_take: 'думка експерта', personal_thought: 'думка Іри' };
const TOPIC = { hotel_place: 'про готель', insider: 'інсайд про готель', tour_offer: '💰 пропозиція тижня', unusual_hotels: '✨ Незвичайні готелі',
  atmosphere: 'атмосфера', behind_scenes: 'за кадром, знімає Іра', template: 'шаблон, тема тижня', video: 'відео з бази',
  personal: 'особисте', personal_take: 'власна думка Іри', tour_expert: 'експертна думка' };
const fmt = (ymd) => ymd ? ymd.slice(8, 10) + '.' + ymd.slice(5, 7) : '';
const what = (s) => {
  const kind = KIND[s.slot_type] || s.slot_type;
  const topic = TOPIC[s.pillar] || String(s.pillar || '').replace(/_/g, ' ');
  let about = '';
  if (s.tour_title) about = ' — тур «' + s.tour_title + '»' + (s.hotel_name ? ', ' + s.hotel_name : '');
  else if (s.hotel_name) about = ' — ' + s.hotel_name;
  else if (s.story_id) about = ' — історія з черги';
  return PLAT[s.platform] + ': ' + kind + ', ' + topic + about;
};
const ws = items[0] && items[0].week_start;
const we = ws ? new Date(new Date(ws + 'T00:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10) : null;
let text = '📅 План TravelLab на тиждень ' + fmt(ws) + '–' + fmt(we) + '\n';
for (const d of DAYS) {
  const day = items.filter(s => s.day === d).sort((a, b) => PORDER.indexOf(a.platform) - PORDER.indexOf(b.platform));
  if (!day.length) continue;
  text += '\n' + d + ' ' + fmt(day[0].scheduled_for) + '\n' + day.map(s => '• ' + what(s)).join('\n') + '\n';
}
const offer = items.find(s => s.pillar === 'tour_offer');
text += '\n' + (offer ? '💰 Пропозиція тижня: ' + (offer.tour_title ? 'тур «' + offer.tour_title + '»' : 'ціна готелю ' + (offer.hotel_name || '')) : '💰 Пропозиції тижня нема — турів і цін у черзі нема');
text += '\nТексти й фото з\'являться в апці TravelLab на перегляд.';
return [{ json: { text } }];`

const wf = JSON.parse(readFileSync(join(here, 'weekly_plan.json'), 'utf8'))
const plan = wf.nodes.find((n) => n.name === PLAN_NODE)
if (!plan) throw new Error('нема вузла ' + PLAN_NODE)
plan.parameters.jsCode = PLAN_CODE

// Рядки content_plan: + week_start, scheduled_for (дата слоту), review_status='planned' (колонки з 002_review_schema.sql)
const PREPARE_CODE = String.raw`const slots = $('Code - Build Weekly Slot Plan').all().map(i => i.json);
return slots.map(s => ({ json: {
  day: s.day,
  platform: s.platform,
  slot_type: s.slot_type,
  pillar: s.pillar,
  tour_id: s.tour_id || null,
  hotel_id: s.hotel_id || null,
  story_id: s.story_id || null,
  pair_key: s.pair_key || null,
  note: s.note || null,
  status: 'draft',
  week_start: s.week_start || null,
  scheduled_for: s.scheduled_for || null,
  review_status: s.review_status || 'planned'
} }));`
const prep = wf.nodes.find((n) => n.name === 'Code - Prepare Content Plan Rows')
prep.parameters.jsCode = PREPARE_CODE
const rep = wf.nodes.find((n) => n.name === 'Code - Format Weekly Report')
rep.parameters.jsCode = REPORT_CODE
// Розклад: неділя 19:00 (Київ) → план наступного тижня готовий до понеділка, Buffer Filler (щодня 07:00) уже бачить слоти
const SCHED_OLD = 'Schedule - Weekly Mon 7:30', SCHED = 'Schedule - Weekly Sun 19:00'
const sched = wf.nodes.find((n) => n.name === SCHED_OLD || n.name === SCHED)
sched.name = SCHED
sched.parameters.rule = { interval: [{ field: 'weeks', triggerAtDay: [0], triggerAtHour: 19, triggerAtMinute: 0 }] }
if (wf.connections[SCHED_OLD]) { wf.connections[SCHED] = wf.connections[SCHED_OLD]; delete wf.connections[SCHED_OLD] }
const ins = wf.nodes.find((n) => n.name === 'Supabase - Insert Content Plan Rows')
const fv = ins.parameters.fieldsUi.fieldValues
for (const f of ['week_start', 'scheduled_for', 'review_status']) {
  if (!fv.some((x) => x.fieldId === f)) fv.push({ fieldId: f, fieldValue: `={{ $json.${f} }}` })
}
// Падіння одного рядка (напр. невідомий CHECK на pillar) не зупиняє вставку решти тижня
ins.onError = 'continueRegularOutput'
// Розклад — за Києвом (раніше часовий пояс інстансу)
wf.settings = { ...wf.settings, timezone: 'Europe/Kyiv' }
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

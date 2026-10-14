// node n8n/build_weekly_plan.mjs [dump|update <id>]
// WF-018 «[TravelLab] Крок 7 Stage 1 - Weekly Slot Plan» (прод SwVveOJhn4qSbEwn): patch-білдер.
// Джерело — знімок n8n/weekly_plan.json (живий WF до правок; історія в git). Міняємо ЛИШЕ Code-вузол плану,
// решта (Schedule, Webhook з Header Auth, Supabase, Telegram-звіт, позначки Assigned/used) — як є.
//
// #7 роадмапу (§27): (а) ліміт оферів, (б) рубрика «Незвичайні готелі» (unusual_hotels, карусель TG+IG).
// Ліміт — з Audience_Strategy_v2 §2.3: TG ~70% користь / ~20% м'яка рекомендація / ~10% прямий офер.
// 5 TG-постів на тиждень → прямий офер ≤ 1 (=20%, найближче ціле до 10%); IG — той самий тур ≤ 1 (Чт).
// 14.10 відповіді Іри (Ira_Voice_Answers_2026-10-14, Audience_Strategy_v3): «у TG можна більше, в IG менше, але не
// розкидатися пропозиціями» → Влад: TG 1 прямий + 1 м'яка рекомендація, IG 1 прямий. Портрети P1–P4 + банк питань:
// тиждень = один портрет (ротація за ISO-тижнем), кожен слот — відповідь на одне питання; persona+питання → note слоту.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLAN_NODE = 'Code - Build Weekly Slot Plan'

export const PLAN_CODE = String.raw`// WF-018 — план тижня. Джерело правди: n8n/build_weekly_plan.mjs (репо travellab-approve)
// Офери (рішення Влада 14.10 за відповіддю Іри): прямий = тур/ціна + дати + CTA; м'який = «якщо для вас важливо X —
// я б дивилась цей готель», без ціни й CTA. Threads — без продажу.
const OFFERS_PER_WEEK = { telegram: 1, instagram: 1 };
const SOFT_PER_WEEK = { telegram: 1, instagram: 0 };

// ── Портрети (Audience_Strategy_v3, зі слів Іри 14.10). match — теги/who_for готелів, які пасують портрету.
const PERSONAS = [
  { id: 'P1', name: 'Пара з приводом', who: 'пара 35–45, ювілей / подарунок / романтика, без дітей; хочуть цікаво, активно і гарно',
    match: /couple|adults|romant|honeymoon|пар|двох|романт|ювіл/i },
  { id: 'P2', name: 'Багатодітна сім\'я', who: 'сім\'я з 2–4 дітьми; потрібна сімейна інфраструктура, вілли / connecting rooms, щоб кожен був зайнятий',
    match: /family|kids|сім|діт|вілл|villa|connect/i },
  { id: 'P3', name: 'Жінки в подорожі', who: 'дві подруги або мама з дочкою; короткі поїздки, комфорт, spa, гарні місця, безпека',
    match: /spa|wellness|women|girls|подруг|жін|релакс/i },
  { id: 'P4', name: 'Європу бачили — далеко ще ні', who: 'активні 35–45 з коштами, об\'їздили Європу, але не були на Індійському океані; бояться перельоту й не знають, як організувати',
    match: /maldiv|мальдів|seychel|сейшел|mauri|маврик|madagas|мадагас|island|остр/i },
];
// Банк питань — справжні питання клієнтів Іри (голосові 14.10). hotel: true — відповідь на прикладі готелю слоту;
// false — загальна експертна тема (Threads, сторіз). Про росіян у постах НЕ пишемо (рішення Влада 14.10).
const TOPIC_BANK = [
  { p: 'P1', hotel: true, q: 'Куди поїхати вдвох на ювілей, щоб було і красиво, і не нудно?' },
  { p: 'P1', hotel: true, q: 'Який готель обрати для сюрпризу-подарунка, щоб вразити, а не просто «гарно»?' },
  { p: 'P1', hotel: true, q: 'Де на островах і активно (снорклінг, спорт), і романтично ввечері?' },
  { p: 'P1', hotel: true, q: 'Як обрати віллу, щоб фото були як у журналі, а не як у всіх?' },
  { p: 'P1', hotel: false, q: 'Чи страшно плавати з акулами й скатами — і чому це найкраща частина поїздки?' },
  { p: 'P1', hotel: false, q: 'За скільки планувати подорож-подарунок на дату, щоб встигнути все добре?' },
  { p: 'P2', hotel: true, q: 'Чим будуть зайняті діти різного віку, поки батьки відпочивають?' },
  { p: 'P2', hotel: true, q: 'Вілла чи connecting rooms — як розселити велику сім\'ю, щоб діти спали окремо від дорослих?' },
  { p: 'P2', hotel: true, q: 'Який пляж і вхід у воду безпечні для малих дітей?' },
  { p: 'P2', hotel: true, q: 'Що в сімейному готелі має бути обов\'язково, коли дітей троє-четверо?' },
  { p: 'P2', hotel: false, q: 'Як довго летіти з дітьми з України і як зробити дорогу легшою?' },
  { p: 'P2', hotel: false, q: 'Близько (Греція, Іспанія) чи далеко — коли з дітьми варто летіти на океан?' },
  { p: 'P3', hotel: true, q: 'Куди поїхати з подругою на 5 днів, щоб відпочити по-справжньому?' },
  { p: 'P3', hotel: true, q: 'Куди поїхати мамі з дочкою, щоб обом було цікаво?' },
  { p: 'P3', hotel: true, q: 'Де гарне spa і спокійна атмосфера без «тусовки»?' },
  { p: 'P3', hotel: false, q: 'Як Іра супроводжує в поїздці: що робити, якщо щось пішло не так?' },
  { p: 'P3', hotel: false, q: 'Як можна оплатити поїздку і що входить у ціну?' },
  { p: 'P4', hotel: true, q: 'Чим острівний готель відрізняється від «шаблонного» резорту, де ви вже були тисячу разів?' },
  { p: 'P4', hotel: true, q: 'Новий нішевий готель чи перевірений відомий — що обрати вперше?' },
  { p: 'P4', hotel: true, q: 'Що побачити на Індійському океані, чого не буде в хорошому готелі в Єгипті?' },
  { p: 'P4', hotel: false, q: 'Чи довго добиратися на Мальдіви з України і як це виглядає насправді?' },
  { p: 'P4', hotel: false, q: 'Сезони на Мальдівах: коли шторми, хвилі й мусони, і чому ціни різні?' },
  { p: 'P4', hotel: false, q: 'Чому ціни на відпочинок стали втричі вищі і з чого складається вартість?' },
  { p: 'P4', hotel: false, q: 'Як організувати першу далеку подорож, якщо ніколи не летіли так далеко?' },
];

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

// ── Фокус тижня: один портрет; питання з банку по колу (кожне коло портретів — наступні питання)
const FOCUS = PERSONAS[WEEK % PERSONAS.length];
const ROUND = Math.floor(WEEK / PERSONAS.length);
const qOf = (hotel) => TOPIC_BANK.filter(t => t.p === FOCUS.id && t.hotel === hotel).map(t => t.q);
const qHotel = qOf(true), qGeneral = qOf(false);
let iH = ROUND * 3, iG = ROUND * 2;
const nextQ = (hotel) => { const a = hotel ? qHotel : qGeneral; if (!a.length) return null; return a[(hotel ? iH++ : iG++) % a.length]; };
// Іра: бронюють за 1–3 міс. (або «треба вже») → говоримо про поїздки найближчих 1–3 місяців, раннє бронювання не рекламуємо
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const m0 = weekStart.getUTCMonth();
const HORIZON = MONTHS[(m0 + 1) % 12] + '–' + MONTHS[(m0 + 3) % 12];

// ── Офер: лише найстаріший готовий тур (≤ OFFERS_PER_WEEK). Решта турів чекає наступних тижнів.
const offerTours = tours.slice(0, Math.max(OFFERS_PER_WEEK.telegram, OFFERS_PER_WEEK.instagram));
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
// Спершу готелі, що пасують портрету тижня (теги / who_for / тип / локація), далі решта — ротація зберігається
const fits = (h) => FOCUS.match.test([(h.tags || []).join(' '), h.who_for, h.type, h.country, h.region, h.name].join(' '));
const rotated = rotate(hotels.filter(h => h.hotel_id && !used.has(h.hotel_id)).sort(byId));
let pool = rotated.filter(fits).concat(rotated.filter(h => !fits(h)));
const nextHotel = () => { const h = pool.shift() || null; if (h) used.add(h.hotel_id); return h ? h.hotel_id : null; };

const pickedStory = stories.length > 0 ? stories[0] : null;
const slots = [];
const S = (o) => slots.push(Object.assign({ tour_id: null, hotel_id: null, story_id: null, pair_key: null }, o));

// Пара A (Пн): був тур-офер → тепер м'яка рекомендація «про готель», без ціни
const hA = nextHotel();
const SOFT = "м'яка рекомендація: «якщо для вас важливо X — я б дивилась цей готель», без ціни й без CTA";
S({ day: 'Пн', platform: 'telegram', slot_type: 'content', pillar: 'hotel_place', hotel_id: hA, pair_key: 'A', soft: SOFT_PER_WEEK.telegram > 0, note: SOFT_PER_WEEK.telegram > 0 ? SOFT : null });
S({ day: 'Пн', platform: 'instagram', slot_type: 'feed_carousel', pillar: 'hotel_place', hotel_id: hA, pair_key: 'A', soft: SOFT_PER_WEEK.instagram > 0, note: SOFT_PER_WEEK.instagram > 0 ? SOFT : null });
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

// IG-офер вимкнено налаштуванням → IG-пара B стає звичайним постом про готель
if (!OFFERS_PER_WEEK.instagram) slots.filter(s => s.platform === 'instagram' && s.pillar === 'tour_offer')
  .forEach(s => Object.assign(s, { pillar: 'hotel_place', tour_id: null, note: null }));

// ── Портрет + питання клієнта → note (генератор отримує slot.note). Пара (pair_key) — одне питання на всі платформи.
// Без питання: відео, «за кадром», особиста історія з черги (не перебиваємо її), прямий офер (висновок тижня)
// «Незвичайні готелі» (своя рубрика — кут уже заданий) і сторіз-шаблон (досить фокусу тижня).
const persona = FOCUS.id + ' ' + FOCUS.name + ' (' + FOCUS.who + ')';
const pairQ = {};
for (const s of slots) {
  if (s.pillar === 'video' || s.pillar === 'behind_scenes') continue;
  const offer = s.pillar === 'tour_offer';
  let q = null;
  if (!offer && !s.story_id && !['unusual_hotels', 'template'].includes(s.pillar)) {
    const hotelQ = !!s.hotel_id;
    const key = s.pair_key ? s.pair_key + (hotelQ ? 'h' : 'g') : null;
    q = key && pairQ[key] !== undefined ? pairQ[key] : nextQ(hotelQ);
    if (key) pairQ[key] = q;
  }
  const parts = ['Для кого: ' + persona + '.'];
  if (q) parts.push('Питання клієнта: «' + q + '» — відповідай цій людині' + (s.hotel_id ? ' на прикладі цього готелю.' : '.'));
  if (offer) parts.push('Офер — логічний висновок тижня для цього портрета.');
  parts.push('Поїздки на ' + HORIZON + '; раннє бронювання не рекламувати.');
  if (s.note) parts.push(s.note);
  Object.assign(s, { note: parts.join(' '), question: q, persona_id: FOCUS.id });
}

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
  return PLAT[s.platform] + ': ' + kind + ', ' + (s.soft ? "🤝 м'яка рекомендація" : topic) + about + (s.question ? '\n   ❓ ' + s.question : '');
};
const ws = items[0] && items[0].week_start;
const we = ws ? new Date(new Date(ws + 'T00:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10) : null;
const focus = items.find(s => s.persona_id);
let text = '📅 План TravelLab на тиждень ' + fmt(ws) + '–' + fmt(we) + '\n';
if (focus) text += '🎯 Фокус тижня: ' + (focus.note || '').replace(/^Для кого: /, '').split(').')[0] + ')\n';
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

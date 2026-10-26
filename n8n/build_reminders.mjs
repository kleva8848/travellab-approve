// node n8n/build_reminders.mjs [dump|create|update <id>]
// «[TravelLab] Reminders & Digest»: кожні 5 хв — нагадування за N хв (settings.remind_before_min) до публікації затвердженого поста,
// щодня о 10:00 — дайджест: що сьогодні виходить, що чекає перегляду, де бракує даних, що прострочено.
// Кому — settings.notify_target: admin | ira | both (на час тестів admin). Ручний запуск: POST вебхук {"mode":"digest"|"remind"}.
// Потрібен supabase/005_reminders.sql (колонка content_plan.reminded_slot).
// «🎙 Історія тижня» (14.10): раз на тиждень (settings.story_remind_dow, дефолт 4 = Чт) у дайджесті — питання-підказка
// (n8n/story_prompt.mjs) і друга кнопка «🎙 Розповісти історію» → бот (?start=story). Якщо в story_queue уже є нова
// історія — лише «історія на суботу вже є», без питання.
// Відео (26.10, сет 5): «🎬 Відео готово на перегляд: N» (video_drafts) і «📹 Бракує кадрів: <тема>» (video_slots, SQL 021).
import { readFileSync, writeFileSync } from 'node:fs'
import { STORY_HINT_JS } from './story_prompt.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
}
const sb = { supabaseApi: CFG.supabase }
let x = 0
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [(x += 220), extra.y ?? 0], parameters, ...extra })

const build = `// Що слати: дайджест (10:00 або вебхук mode=digest) чи нагадування (кожні 5 хв або mode=remind)
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
// аудиторії з апки (SQL 017) — для підказки історії; вузол з onError=continue → рядок {error} без code відкидається
const aud = $('Supabase - Get Audiences').all().map(i => i.json).filter(j => j && j.code);
const fromHook = $('Webhook - Manual Run').isExecuted ? String(($('Webhook - Manual Run').first().json.body || {}).mode || 'digest') : '';
const mode = fromHook || ($('Schedule - Digest 10:00').isExecuted ? 'digest' : 'remind');

const target = String(s.notify_target || 'admin');
const chats = [...new Set([
  target !== 'ira' ? String(s.admin_chat_id || '') : '',
  target !== 'admin' ? String(s.ira_chat_id || '') : '',
].filter(Boolean))];
if (!chats.length) throw new Error('немає отримувача: заповни settings.admin_chat_id / ira_chat_id (notify_target=' + target + ')');
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
if (!base) throw new Error('settings.mini_app_url порожній');

const hotels = {}, tours = {};
for (const h of $('Supabase - Get Hotels').all()) if (h.json.hotel_id) hotels[h.json.hotel_id] = h.json.name;
for (const t of $('Supabase - Get Tours').all()) if (t.json.tour_id) tours[t.json.tour_id] = t.json.title;
const plans = $('Supabase - Get Open Plans').all().map(i => i.json).filter(p => p.id);

const PLAT = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' };
const title = p => hotels[p.hotel_id] || tours[p.tour_id] || p.pillar || 'пост';
const hhmm = p => String(p.slot_time || '').slice(0, 5);
const slotKey = p => p.scheduled_for + ' ' + hhmm(p);
const zone = 'Europe/Kyiv';
const now = DateTime.now().setZone(zone);
const slotAt = p => (p.scheduled_for && p.slot_time) ? DateTime.fromISO(p.scheduled_for + 'T' + hhmm(p), { zone }) : null;
const postUrl = p => base + '/?startapp=post_' + p.id;
const out = [];

if (mode === 'remind') {
  const before = Number(s.remind_before_min) || 30;
  for (const p of plans) {
    if (p.review_status !== 'approved' || p.published_at) continue;
    const at = slotAt(p);
    if (!at) continue;
    const mins = at.diff(now, 'minutes').minutes;
    if (mins <= 0 || mins > before || p.reminded_slot === slotKey(p)) continue;
    const text = '⏰ Через ' + Math.ceil(mins) + ' хв публікація\\n' + hhmm(p) + ' · ' + (PLAT[p.platform] || p.platform) + '\\n' + title(p) + '\\n\\nТекст і фото готові — відкрий, скопіюй і виклади. Після публікації тисни «Виклала».';
    for (const chat_id of chats) out.push({ json: { kind: 'remind', chat_id, text, url: postUrl(p), button: 'Відкрити пост', plan_id: p.id, slot: slotKey(p) } });
  }
  return out;
}

// Дайджест
const today = now.toFormat('yyyy-MM-dd');
const line = p => '• ' + (hhmm(p) || '—') + ' ' + (PLAT[p.platform] || p.platform) + ' — ' + title(p);
const bySlot = (a, b) => slotKey(a).localeCompare(slotKey(b));
const todayPosts = plans.filter(p => p.review_status === 'approved' && !p.published_at && p.scheduled_for === today && (slotAt(p) || now) >= now).sort(bySlot);
const missed = plans.filter(p => p.review_status === 'approved' && !p.published_at && slotAt(p) && slotAt(p) < now).sort(bySlot);
const review = plans.filter(p => p.review_status === 'ready_for_review');
const needData = plans.filter(p => p.review_status === 'needs_data');
const inWork = plans.filter(p => ['changes_requested', 'regenerating', 'generating'].includes(p.review_status));

const parts = ['☀️ Доброго ранку! ' + now.setLocale('uk').toFormat('cccc, d MMMM')];
parts.push(todayPosts.length ? '\\n📅 Сьогодні виходить:\\n' + todayPosts.map(line).join('\\n') : '\\n📅 Сьогодні публікацій немає');
if (missed.length) parts.push('\\n⚠️ Час минув, ще не викладено:\\n' + missed.slice(0, 5).map(p => line(p) + ' (' + DateTime.fromISO(p.scheduled_for).toFormat('dd.MM') + ')').join('\\n'));
if (review.length) parts.push('\\n📝 Чекають твого перегляду: ' + review.length + '\\n' + review.slice(0, 5).map(p => '• ' + (PLAT[p.platform] || p.platform) + ' — ' + title(p)).join('\\n') + (review.length > 5 ? '\\n…' : ''));
if (needData.length) parts.push('\\n❓ Бракує даних: ' + needData.length);
if (inWork.length) parts.push('\\n🔄 Агент переробляє: ' + inWork.length);
// Відео (SQL 018/021, montage-test/video_agent.py): готові чернетки сторіз/рілс і слоти, де агенту бракує кадрів.
// Таблиць ще нема → вузли з onError=continue дають рядок {error} без id → просто не показуємо
const vday = v => DateTime.fromISO(String(v)).setZone(zone).setLocale('uk').toFormat('ccc dd.MM');
const vids = $('Supabase - Get Video Drafts').all().map(i => i.json).filter(j => j && j.id);
const gaps = $('Supabase - Get Video Gaps').all().map(i => i.json).filter(j => j && j.plan_id && String(j.scheduled_for) >= today)
  .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)));
if (vids.length) parts.push('\\n🎬 Відео готово на перегляд: ' + vids.length + '\\n' + vids.slice(0, 5).map(v => '• ' + (v.format === 'reel' ? 'Рілс' : 'Сторіз') + ' «' + v.name + '»' + (v.scheduled_for ? ' — на ' + vday(v.scheduled_for) : '')).join('\\n'));
if (gaps.length) parts.push('\\n📹 Бракує кадрів:\\n' + gaps.slice(0, 3).map(g => '• ' + vday(g.scheduled_for) + ' ' + (g.topic || 'відео') + (g.need ? ' — ' + g.need : '')).join('\\n') + '\\nЗакинь відео в Drive → 00_Inbox (у боті /video).');
// Історія тижня — у свій день; у черзі вже є нова → не просимо ще
${STORY_HINT_JS}
const storyDow = s.story_remind_dow === undefined || s.story_remind_dow === null ? 4 : Number(s.story_remind_dow);
const storiesNew = $('Supabase - Get New Stories').all().map(i => i.json).filter(j => j && j.id).length;
let story_url = '';
if (storyDow && now.weekday === storyDow) {
  if (storiesNew) parts.push('\\n🎙 Історія на суботу вже є ✅' + (storiesNew > 1 ? ' (у черзі ' + storiesNew + ')' : ''));
  else {
    parts.push('\\n🎙 Історія тижня — для суботнього поста. Підказка:\\n«' + storyHint().hint + '»\\nАбо будь-яка інша, 1–3 хв голосом.');
    story_url = 'https://t.me/' + String(s.bot_username || 'travellab_studio_bot').replace(/^@/, '') + '?start=story';
  }
}
if (!todayPosts.length && !missed.length && !review.length && !needData.length && !story_url && !vids.length && !gaps.length) parts.push('\\nВсе чисто — можна відпочивати 🌴');
for (const chat_id of chats) out.push({ json: { kind: 'digest', chat_id, text: parts.join('\\n'), url: base, button: 'Відкрити застосунок', story_url } });
return out;`

const tgCreds = { credentials: { telegramApi: CFG.telegram } }
// Текст як є: без parse_mode вузол шле Markdown, і «_» у назві (personal_take) ламав дайджест (26.10, exec 76463) → HTML з екрануванням
const TEXT_HTML = "={{ $json.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}"
const always = { executeOnce: true, alwaysOutputData: true }
const nodes = [
  node('Schedule - Every 5 min', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }),
  node('Schedule - Digest 10:00', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '0 10 * * *' }] } }, { y: 200 }),
  node('Webhook - Manual Run', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-reminders', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '3f8b2c61-5d7e-4a90-b1c4-tl-reminders', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 400 }),
  node('Supabase - Get Settings', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'settings', returnAll: true }, { credentials: sb, executeOnce: true }),
  node('Supabase - Get Open Plans', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'content_plan', returnAll: true,
    filterType: 'string', filterString: 'review_status=in.(approved,ready_for_review,needs_data,changes_requested,regenerating,generating)&published_at=is.null',
  }, { credentials: sb, ...always }),
  node('Supabase - Get Hotels', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'hotels', returnAll: true }, { credentials: sb, ...always }),
  node('Supabase - Get Tours', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'tours', returnAll: true }, { credentials: sb, ...always }),
  node('Supabase - Get New Stories', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'story_queue', returnAll: true, filterType: 'string', filterString: 'status=eq.new',
  }, { credentials: sb, ...always, onError: 'continueRegularOutput' }),
  node('Supabase - Get Audiences', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'audiences', returnAll: true },
    { credentials: sb, ...always, onError: 'continueRegularOutput' }),
  node('Supabase - Get Video Drafts', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'video_drafts', returnAll: true, filterType: 'string', filterString: 'status=eq.ready_for_review',
  }, { credentials: sb, ...always, onError: 'continueRegularOutput' }),
  node('Supabase - Get Video Gaps', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'video_slots', returnAll: true, filterType: 'string', filterString: 'state=eq.gap',
  }, { credentials: sb, ...always, onError: 'continueRegularOutput' }),
  node('Code - Build Messages', 'n8n-nodes-base.code', 2, { jsCode: build }, { executeOnce: true }),
  node('IF - Story Button?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'story', leftValue: '={{ !!$json.story_url }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }),
  // дайджест з другою кнопкою: url-кнопка в чат з ботом (/start story), не web_app
  node('Telegram - Send With Story', 'n8n-nodes-base.telegram', 1.2, {
    chatId: '={{ $json.chat_id }}', text: TEXT_HTML, replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [{ text: '🎙 Розповісти історію', additionalFields: { url: '={{ $json.story_url }}' } }] } },
      { row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } },
    ] },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
  }, { ...tgCreds, onError: 'continueRegularOutput' }),
  node('Telegram - Send', 'n8n-nodes-base.telegram', 1.2, {
    chatId: '={{ $json.chat_id }}', text: TEXT_HTML, replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
  }, { ...tgCreds, onError: 'continueRegularOutput' }),
  node('IF - Reminder Sent?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [
        { id: 'kind', leftValue: "={{ $('Code - Build Messages').item.json.kind }}", rightValue: 'remind', operator: { type: 'string', operation: 'equals' } },
        { id: 'ok', leftValue: '={{ !$json.error }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
      ] },
    options: {},
  }),
  node('Supabase - Mark Reminded', 'n8n-nodes-base.supabase', 1, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: "={{ $('Code - Build Messages').item.json.plan_id }}" }] },
    dataToSend: 'defineBelow', fieldsUi: { fieldValues: [{ fieldId: 'reminded_slot', fieldValue: "={{ $('Code - Build Messages').item.json.slot }}" }] },
  }, { credentials: sb }),
]

const to = (n) => ({ main: [[{ node: n, type: 'main', index: 0 }]] })
const connections = {
  'Schedule - Every 5 min': to('Supabase - Get Settings'),
  'Schedule - Digest 10:00': to('Supabase - Get Settings'),
  'Webhook - Manual Run': to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Supabase - Get Open Plans'),
  'Supabase - Get Open Plans': to('Supabase - Get Hotels'),
  'Supabase - Get Hotels': to('Supabase - Get Tours'),
  'Supabase - Get Tours': to('Supabase - Get New Stories'),
  'Supabase - Get New Stories': to('Supabase - Get Audiences'),
  'Supabase - Get Audiences': to('Supabase - Get Video Drafts'),
  'Supabase - Get Video Drafts': to('Supabase - Get Video Gaps'),
  'Supabase - Get Video Gaps': to('Code - Build Messages'),
  'Code - Build Messages': to('IF - Story Button?'),
  'IF - Story Button?': { main: [[{ node: 'Telegram - Send With Story', type: 'main', index: 0 }], [{ node: 'Telegram - Send', type: 'main', index: 0 }]] },
  'Telegram - Send': to('IF - Reminder Sent?'),
  'IF - Reminder Sent?': to('Supabase - Mark Reminded'),
}
for (const n of nodes) delete n.y
const wf = { name: '[TravelLab] Reminders & Digest', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'reminders.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/reminders.json')
} else {
  const mcp = JSON.parse(readFileSync(join(here, '..', '..', '..', '.mcp.json'), 'utf8'))
  const env = (mcp.mcpServers || mcp)['n8n-mcp'].env
  const base = env.N8N_API_URL.replace(/\/$/, '')
  const api = base.endsWith('/api/v1') ? base : base + '/api/v1'
  const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' }
  const url = mode === 'update' ? `${api}/workflows/${process.argv[3]}` : `${api}/workflows`
  const r = await fetch(url, { method: mode === 'update' ? 'PUT' : 'POST', headers, body: JSON.stringify(wf) })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch {}
  console.log(r.status, j ? `${j.id} ${j.name} active=${j.active}` : t.slice(0, 500))
}

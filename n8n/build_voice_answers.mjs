// node n8n/build_voice_answers.mjs [dump | create | update <coreId> <botId>]
// Голос через бот Іри (рішення #1 плану): кнопка в апці «Відповісти голосом» → t.me/<бот>?start=answer_<plan_id> →
// бот ставить саме ці питання → Іра одне голосове (або текст) у відповідь → Whisper → gpt-4.1 розкладає по питаннях →
// data_requests answered (answered_via voice_bot) → «Дякую! Записав: … Дописую пост» + web_app «Повернутись у TravelLab» →
// Data Answer (той самий шлях, що й відповідь з апки) → «✨ Нова версія готова».
//
// Два воркфлоу:
//  1) «[TravelLab] Voice Answers (Mini App)» — ядро. Тригери: Execute Workflow (з бота) і тестовий вебхук
//     travellab-bot-update-test (Header Auth, тіло = Telegram update). Відповідає лише в чат автора апдейту
//     і лише Ірі / Владу (settings.ira_chat_id / admin_chat_id); решту ігнорує.
//  2) «[TravelLab] Ira Bot (updates)» — Telegram Trigger на бот Іри → ядро. НЕАКТИВНИЙ: активація = setWebhook бота Іри.
//     Перед активацією перевірити getWebhookInfo (url має бути порожній), потім settings.voice_answers = "on" (кнопка в апці).
// Стан розмови не зберігаємо: питання бот шле з force_reply і прихованим посиланням на пост; відповідь Іри = reply на нього.
// Не reply (просто голосове) → якщо в «бракує даних» рівно один пост — до нього; нема жодного — це історія; інакше просимо відповісти на питання.
//
// «🎙 Розповісти історію» (14.10): /story, /start story (кнопка в апці й дайджесті) або текст «🎙 Розповісти історію» → бот
// ставить питання-підказку тижня (settings.story_prompts, n8n/story_prompt.mjs) з force_reply і прихованим маркером
// ?start=story → голосове/текст у відповідь → Whisper → gpt-4.1 чистить розшифровку (її слова, без вигадок) + готель/країна →
// story_queue (pillar personal_experience, status new) → WF-018 бере найстарішу в суботній слот наступного тижня.
//
// «🎬 Відео» (21.10, тест рілсів): /video (або /start video) → посилання на Travel lab/00_Inbox; «відео готово» →
// бот рахує відео в Inbox і його підпапках (Drive Іри) → Ірі підсумок, Владу (admin_chat_id) — «можна розбирати».
// Розбір і монтаж поки робить Claude на Mac (Reels_Test_Plan_2026-10-21), потім — воркер на VPS.
// «🎙 Голос до відео» (26.10, сет 6): кнопка в апці «Озвучити голосом» → /start vo_<draft_id> → бот просить голосове
// з force_reply і прихованим маркером ?start=vo_<id> → голосове у відповідь → заявка video_drafts.remount {kind: voice, file_id}
// (лише якщо відео не монтується) → воркер на Mac (montage-test/remount_worker.py): очистка, Whisper, субтитри, кадри під голос.
// «✅ Виклала» (26.10, сет 7): Vercel /api/publish у слот шле Ірі в чат готове відео + підпис з кнопкою callback vpub_<draft_id> →
// video_drafts.published_at (лише якщо ще порожньо) → «Позначила ✅» + кнопка відкрити відео в апці.
// /help або /start — меню кнопок (усі дії без набору тексту). Кнопки callback (video_ask / video_ready / story / help)
// = ті самі команди: Normalize перетворює callback_query на текст, бот одразу відповідає answerCallbackQuery.
import { readFileSync, writeFileSync } from 'node:fs'
import { STORY_HINT_JS, STORY_MARK_RE } from './story_prompt.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  // [TravelLab] Data Answer (Mini App) — n8n/build_data_answer.mjs
  dataAnswerId: process.env.TL_DATA_ANSWER_ID || '7LRWGhCgnoM8MXmW',
  drive: { id: 'cjY7BSZAIddR6oLs', name: 'Google Drive Іра' },
  // Travel lab/00_Inbox на Drive Іри — сюди вона кидає відео (/video), розбір — після «відео готово»
  inboxId: '1py-eratM0G1dr8gGI94PXJMx7DziXk9K',
}
const sb = { supabaseApi: CFG.supabase }
const tgc = { credentials: { telegramApi: CFG.telegram } }
const node = (name, type, typeVersion, x, parameters, extra = {}) => {
  const { y = 0, ...rest } = extra
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, y], parameters, ...rest }
}
const always = { alwaysOutputData: true, executeOnce: true }
const getAll = (name, x, table, filterString, extra = {}) =>
  node(name, 'n8n-nodes-base.supabase', 1, x, {
    operation: 'getAll', tableId: table, returnAll: true,
    ...(filterString ? { filterType: 'string', filterString } : {}),
  }, { credentials: sb, ...always, ...extra })
const rest = (name, x, method, url, body, extra = {}) => {
  const { prefer = 'return=minimal', ...rest2 } = extra
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, x, {
    method, url,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Prefer', value: prefer }] },
    sendBody: true, specifyBody: 'json', jsonBody: body,
    options: { response: { response: { fullResponse: true, neverError: true } } },
  }, { credentials: sb, onError: 'continueRegularOutput', ...rest2 })
}
const ifNode = (name, x, leftValue, extra = {}) => node(name, 'n8n-nodes-base.if', 2.2, x, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), leftValue, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
  options: {},
}, extra)

// ───────────────────────── Code ─────────────────────────
const normalize = `// Telegram update (з тригера бота або з тестового вебхука) → що хоче людина
const b = $json.body && typeof $json.body === 'object' && ($json.body.message || $json.body.callback_query || $json.body.update_id) ? $json.body : $json;
// натиснута кнопка = та сама команда текстом
const CB = { video_ask: '/video', video_ready: 'відео готово', story: '/story', help: '/help' };
const cq = b.callback_query || null;
// «✅ Виклала» під відео, яке бот надіслав у слот (server/video_publish.ts)
const vp = cq ? String(cq.data || '').match(/^vpub_([0-9a-f-]{36})$/i) : null;
const m = cq ? { chat: cq.message && cq.message.chat, from: cq.from, text: CB[cq.data] || '/help' } : (b.message || {});
const text = String(m.text || m.caption || '').trim();
const file = (m.voice && m.voice.file_id) || (m.audio && m.audio.file_id) || (m.video_note && m.video_note.file_id) || null;
const audio = (m.voice || m.audio) ? { file_id: (m.voice || m.audio).file_id, dur: Number((m.voice || m.audio).duration || 0) } : null;
let planId = null, how = 'none', videoId = null;
// «🎙 Озвучити голосом» з апки: /start vo_<id> — голос до відео
const vo = text.match(/^\\/start(?:@\\w+)?\\s+vo_([0-9a-f-]{36})\\b/i);
if (vo) videoId = vo[1].toLowerCase();
if (vp) videoId = vp[1].toLowerCase();
const st = text.match(/^\\/start(?:@\\w+)?\\s+answer_([0-9a-f-]{36})\\b/i);
if (st) { planId = st[1].toLowerCase(); how = 'start'; }
// «Розповісти історію»: команда, deep link з апки/дайджесту або кнопка-текст
const storyCmd = /^\\/story(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+story$/i.test(text) || /розповісти історію/i.test(text);
// «🎬 Відео»: посилання на Inbox і «відео готово» після завантаження
const videoCmd = /^\\/video(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+video$/i.test(text) || /^(🎬\\s*)?завантажити відео$/i.test(text);
const videoReady = /^(\\/videodone(?:@\\w+)?|відео\\s+готов[оі]?)[.!\\s]*$/i.test(text);
const r = m.reply_to_message;
if (!planId && r) {
  for (const e of [...(r.entities || []), ...(r.caption_entities || [])]) {
    const u = String(e.url || '');
    const mm = u.match(/post_([0-9a-f-]{36})/i);
    if (mm) { planId = mm[1].toLowerCase(); how = 'reply'; break; }
    const mv = u.match(/start=vo_([0-9a-f-]{36})/i);
    if (mv) { videoId = mv[1].toLowerCase(); how = 'vo'; break; }
    if (${STORY_MARK_RE}.test(u)) { how = 'story'; break; }
  }
}
let route = 'ignore';
if (!m.chat || !m.from || m.from.is_bot) route = 'ignore';
else if (vp) route = 'vpub';
else if (vo) route = 'vo_ask';
else if (how === 'vo') route = 'vo';
else if (st) route = 'ask';
else if (videoCmd && !file) route = 'video_ask';
else if (videoReady && !file) route = 'video_ready';
else if (storyCmd && !file) route = 'story_ask';
else if (how === 'story' && (file || text)) route = 'story';
else if (file || (text && how === 'reply')) route = 'answer';
else if (text) route = 'help';
return [{ json: { route, plan_id: planId, video_id: videoId, audio, how, chat_id: m.chat ? String(m.chat.id) : '', from_id: m.from ? String(m.from.id) : '', text: file ? '' : text, file_id: file, callback_id: cq ? cq.id : null } }];`

const resolve = `// Хто пише (лише Іра / Влад), до якого поста, які відкриті питання
const n = $('Code - Normalize').first().json;
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const s = {};
for (const r of all('Supabase - Get Settings')) s[r.key] = r.value;
const aud = all('Supabase - Get Audiences');
${STORY_HINT_JS}
const allowed = [s.ira_chat_id, s.admin_chat_id].filter(Boolean).map(String);
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
const bot = String(s.bot_username || 'travellab_studio_bot').replace(/^@/, '');
const out = { ...n, mini_app_url: base, supabase_url: String(s.supabase_url || '').replace(/\\/$/, ''), story_url: 'https://t.me/' + bot + '?start=story', admin_chat_id: String(s.admin_chat_id || '') };
if (n.route === 'ignore' || !allowed.includes(n.from_id)) return [{ json: { ...out, route: 'ignore' } }];
if (n.route === 'video_ask' || n.route === 'video_ready') return [{ json: out }];
if (n.route === 'story_ask') return [{ json: { ...out, ...storyHint() } }];
if (n.route === 'story') return [{ json: out }];
if (n.route === 'vpub') {
  const v = all('Supabase - Get Video Draft')[0] || null;
  if (!v || v.status === 'skipped') return [{ json: { ...out, route: 'vo_gone' } }];
  return [{ json: { ...out, video: { id: v.id, name: v.name, format: v.format, published_at: v.published_at || null },
    row: { published_at: new Date().toISOString(), published_ref: { ...(v.published_ref || {}), posted_via: 'bot', posted_by: Number(n.from_id) } },
    video_url: base ? base + '/?startapp=video_' + v.id : base } }];
}
if (n.route === 'vo_ask' || n.route === 'vo') {
  const v = all('Supabase - Get Video Draft')[0] || null;
  if (!v || v.status === 'skipped') return [{ json: { ...out, route: 'vo_gone' } }];
  return [{ json: { ...out, video: { id: v.id, name: v.name, format: v.format, has_voice: !!(v.montage && v.montage.voice) },
    vo_url: 'https://t.me/' + bot + '?start=vo_' + v.id, video_url: base ? base + '/?startapp=video_' + v.id : base } }];
}

const reqs = all('Supabase - Get Open Requests');
const forPlan = (p) => reqs.filter(q => q.content_plan_id === p.id || (p.hotel_id && q.hotel_id === p.hotel_id) || (p.tour_id && q.tour_id === p.tour_id))
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const plans = all('Supabase - Get Plans');
let plan = n.plan_id ? plans.find(p => p.id === n.plan_id) || null : null;
if (!plan && !n.plan_id && n.route === 'answer') {
  // просто голосове, не відповідь на питання: якщо «бракує даних» рівно в одному пості — до нього
  const c = plans.filter(p => p.review_status === 'needs_data' && !p.published_at && forPlan(p).length);
  if (c.length === 1) plan = c[0];
  // жодного поста з питаннями, а голосове є → це історія для постів
  if (!c.length && n.file_id) return [{ json: { ...out, route: 'story', how: 'plain' } }];
}
if (n.route === 'help') return [{ json: { ...out, route: 'help' } }];
if (!plan) return [{ json: { ...out, route: n.plan_id ? 'gone' : 'unresolved' } }];

const hotels = Object.fromEntries(all('Supabase - Get Hotels').map(h => [h.hotel_id, h]));
const tours = Object.fromEntries(all('Supabase - Get Tours').map(t => [t.tour_id, t]));
const plat = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }[plan.platform] || plan.platform;
const title = ((plan.hotel_id && hotels[plan.hotel_id]) || {}).name || ((plan.tour_id && tours[plan.tour_id]) || {}).title || plan.pillar;
const qs = forPlan(plan).map(q => ({ id: q.id, field: q.field, question: q.question }));
return [{ json: { ...out, plan, title: title + ' · ' + plat, questions: qs, post_url: base ? base + '/?startapp=post_' + plan.id : '' } }];`

// HTML-повідомлення з force_reply: приховане посилання на пост (щоб відповідь Іри знала, до якого поста)
const esc = `const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hidden = (url) => url ? '<a href="' + esc(url) + '">\\u200b</a>' : '';
const list = (qs) => qs.map((q, i) => (qs.length > 1 ? (i + 1) + '. ' : '') + esc(q.question)).join('\\n');`

const ask = `${esc}
// /start answer_<id>: бот ставить саме питання цього поста
const r = $json;
if (!r.questions.length) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'По цьому посту питань уже немає 🙌', url: r.post_url, button: 'Повернутись у TravelLab' } }];
return [{ json: {
  chat_id: r.chat_id, kind: 'force',
  text: hidden(r.post_url) + '<b>' + esc(r.title) + '</b>\\nАгенту бракує ' + (r.questions.length === 1 ? 'одного факту' : 'кількох фактів') + ':\\n\\n' + list(r.questions)
    + '\\n\\n🎙 Запиши одне голосове з відповідями ' + (r.questions.length > 1 ? 'на всі питання' : '') + ' — у відповідь на це повідомлення. Можна й текстом.'
} }];`

const simple = `// help / unresolved / gone / нема питань — коротко + кнопка в апку
const r = $json;
const T = {
  help: 'Привіт! Я бот TravelLab. Що я вмію — тисни кнопку нижче:\\n\\n'
    + '📱 Відкрити TravelLab — пости на перегляд: затвердити, попросити правку, вибрати фото.\\n\\n'
    + '🎬 Завантажити відео — дам папку на Диску. Закинь туди відео з телефона чи компʼютера, повернись сюди й натисни «✅ Відео готово».\\n\\n'
    + '🎙 Розповісти історію — запишеш голосове, я зроблю з нього пост.\\n\\n'
    + '❓ Питання агента до поста — відкрий пост в апці й натисни «Відповісти голосом».\\n\\n'
    + '📷 Фото поки що — через бот завантаження фото, скоро переїде сюди.\\n\\n'
    + 'Загубила меню — напиши /help.',
  unresolved: 'Не зрозумів, до якого поста ця відповідь 🙈 Відкрий пост у TravelLab і натисни «Відповісти голосом» — я поставлю питання ще раз.\\n\\nЯкщо це історія для постів — надішли /story і запиши її у відповідь.',
  gone: 'Цього поста вже немає в роботі 🙌',
  vo_gone: 'Цього відео вже немає в роботі 🙌',
  none: 'По цьому посту питань уже немає 🙌'
};
const k = r.route === 'answer' ? 'none' : r.route;
const kind = (k === 'help' || !T[k]) ? 'menu' : 'button';
return [{ json: { chat_id: r.chat_id, kind, text: T[k] || T.help, url: (k === 'none' && r.post_url) || r.mini_app_url, button: k === 'none' ? 'Повернутись у TravelLab' : 'Відкрити TravelLab' } }];`

// «✅ Виклала»: позначка стала (рядок повернувся) або вже стояла раніше
const posted = `const r = $('Code - Resolve').first().json;
const c = $json;
const ok = c.statusCode >= 200 && c.statusCode < 300 && Array.isArray(c.body) && c.body.length > 0;
const fail = !ok && !(c.statusCode >= 200 && c.statusCode < 300);
const what = (r.video.format === 'reel' ? 'Рілс' : 'Сторіз') + ' «' + r.video.name + '»';
const text = fail ? 'Не вдалось позначити 🙈 Відкрий відео в апці й натисни «✅ Виклала» там.'
  : ok ? 'Позначила ✅ ' + what + ' — опубліковано. Дякую!' : what + ' уже позначено як опубліковане ✓';
return [{ json: { chat_id: r.chat_id, kind: 'button', text, url: r.video_url || r.mini_app_url, button: 'Відкрити відео' } }];`

const resolveText = `// Текст відповіді: розшифровка голосового або текст як є
const r = $('Code - Resolve').first().json;
let text = r.text || '';
if (r.file_id) { try { text = String($('OpenAI - Transcribe').first().json.text || '').trim(); } catch (e) { text = ''; } }
return [{ json: { ...r, answer_text: text } }];`

const PARSE_SYSTEM = [
  'Ти розбираєш відповідь Ірини (TravelLab, luxury travel) на питання агента для поста. Дано пронумеровані питання з id і її відповідь — часто це розшифровка голосового, можуть бути помилки розпізнавання.',
  'Для кожного питання випиши, що вона відповіла: її словами, коротко (1–2 речення), без вступів. Нічого не вигадуй і не додавай від себе.',
  'Ціни й дати — точно як сказала (число, валюта, місяць). Якщо на питання вона не відповіла або сказала «не знаю» — answer null.',
  'Одна відповідь може стосуватись кількох питань — тоді розклади по відповідних id.',
  'Відповідь — СТРОГО JSON без іншого тексту: {"answers": [{"id": "<id питання>", "answer": "текст" або null}]}',
].join('\n')

const parsePrompt = `const r = $json;
const user = 'ПИТАННЯ:\\n' + r.questions.map((q, i) => (i + 1) + '. [id: ' + q.id + '] ' + q.question).join('\\n') + '\\n\\nВІДПОВІДЬ ІРИНИ:\\n<<<\\n' + r.answer_text + '\\n>>>';
return [{ json: { ...r, systemPrompt: ${JSON.stringify(PARSE_SYSTEM)}, userPrompt: user } }];`

const parseAnswers = `// Відповідь моделі → які питання закрито
const r = $('Code - Resolve Text').first().json;
let out = null;
try {
  const j = $json;
  const message = Array.isArray(j.output) ? j.output[0] : j;
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  out = JSON.parse(raw);
} catch (e) { out = null; }
const ids = new Set(r.questions.map(q => q.id));
const got = [];
for (const a of (out && Array.isArray(out.answers) ? out.answers : [])) {
  const t = a && typeof a.answer === 'string' ? a.answer.replace(/\\s+/g, ' ').trim().slice(0, 1000) : '';
  if (a && ids.has(a.id) && t && !got.some(g => g.id === a.id)) got.push({ id: a.id, answer: t });
}
const remaining = r.questions.filter(q => !got.some(g => g.id === q.id));
return [{ json: { ...r, got, remaining, all_done: got.length > 0 && remaining.length === 0, heard: !!r.answer_text } }];`

const notHeard = `${esc}
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.post_url) + (r.heard ? 'Не розчув відповідей на ці питання 🙈' : 'Не вдалось розібрати голосове 🙈') + '\\n\\n' + list(r.questions) + '\\n\\nЗапиши ще раз у відповідь на це повідомлення, будь ласка.'
} }];`

const answerItems = `const r = $('Code - Parse Answers').first().json;
return r.got.map(g => ({ json: { id: g.id, answer: g.answer, supabase_url: r.supabase_url } }));`

const afterSave = `${esc}
// Після запису: всі відповіді → забрали пост у роботу → «Дякую! Записав… Дописую пост»; частина → дописати решту
const r = $('Code - Parse Answers').first().json;
const saved = $('HTTP - Save Answer').all().map(i => i.json).filter(j => j && j.statusCode >= 200 && j.statusCode < 300).length;
const qa = r.got.map(g => '• ' + esc(g.answer)).join('\\n');
if (!saved) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'Не вдалось записати відповідь 🙈 Спробуй ще раз або відповідай в апці.', url: r.post_url, button: 'Повернутись у TravelLab', claim: false } }];
if (r.remaining.length) return [{ json: { chat_id: r.chat_id, kind: 'force', claim: false,
  text: hidden(r.post_url) + 'Записав ✅\\n' + qa + '\\n\\nЛишилось:\\n' + list(r.remaining) + '\\n\\nДозапиши, будь ласка, у відповідь на це повідомлення.'
} }];
return [{ json: { chat_id: r.chat_id, kind: 'button', claim: true, text: 'Дякую! Записав:\\n' + qa + '\\n\\nДописую пост ✍️', url: r.post_url, button: 'Повернутись у TravelLab' } }];`

const runInput = `// Вхід для Data Answer (той самий, що з апки)
const r = $('Code - Parse Answers').first().json;
return [{ json: { content_plan_id: r.plan.id, expected_version_no: Number(r.plan.version_no || 0), author_tg_id: r.from_id, via: 'voice_bot', prev_status: r.plan.review_status } }];`

// ───── «🎙 Розповісти історію» ─────
const storyAsk = `${esc}
// /story: питання-підказка тижня + force_reply з прихованим маркером ?start=story (відповідь на нього = історія)
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.story_url) + '🎙 <b>Історія для постів</b>\\n\\nПідказка цього тижня:\\n<i>' + esc(r.hint) + '</i>\\n\\n'
    + 'Або будь-яка інша історія — твоя чи клієнтів. Запиши голосове на 1–3 хв у відповідь на це повідомлення (можна й текстом). '
    + 'Імена клієнтів не обовʼязково — я їх не пишу. Історія піде в найближчий суботній пост, текст побачиш в апці до публікації.'
} }];`

const storyText = `// Текст історії: розшифровка голосового або текст як є
const r = $('Code - Resolve').first().json;
let text = r.text || '';
if (r.file_id) { try { text = String($('OpenAI - Transcribe Story').first().json.text || '').trim(); } catch (e) { text = ''; } }
text = text.replace(/^\\/story(@\\w+)?\\s*/i, '').trim();
const words = text ? text.split(/\\s+/).length : 0;
return [{ json: { ...r, story_raw: text, words, long_enough: words >= 12 } }];`

const STORY_SYSTEM = [
  'Ти готуєш голосову історію Ірини (TravelLab, luxury travel агентка) для черги постів. Дано розшифровку голосового — можуть бути помилки розпізнавання, слова-паразити, повтори — і список готелів бази.',
  'clean: та сама історія її словами, від першої особи, як вона розповіла. Прибери «ну», «ееее», «коротше», повтори й обірвані фрази, виправ очевидні помилки розпізнавання (назви готелів і місць — за списком). НЕ скорочуй суть, НЕ додавай подробиць, оцінок і висновків, яких вона не казала. Імена клієнтів заміни на «клієнти», «пара», «мама з донькою» тощо.',
  'title: 3–6 слів, про що історія (для звіту Владу).',
  'hotel_id: id готелю зі списку, якщо історія саме про нього; інакше null. destination: країна або острів, якщо названо; інакше null.',
  'is_story: false, якщо це не історія з поїздок/роботи (тест мікрофона, випадкове повідомлення, питання до бота).',
  'Відповідь — СТРОГО JSON без іншого тексту: {"clean": "...", "title": "...", "hotel_id": "HTL-…" або null, "destination": "..." або null, "is_story": true}',
].join('\n')

const storyPrompt = `const r = $json;
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && j.hotel_id); } catch (e) { return []; } };
const hotels = all('Supabase - Get Hotels').map(h => h.hotel_id + ' — ' + (h.name || '') + (h.country ? ' (' + h.country + ')' : '')).join('\\n');
const user = 'ГОТЕЛІ БАЗИ:\\n' + (hotels || '—') + '\\n\\nРОЗШИФРОВКА ІСТОРІЇ ІРИНИ:\\n<<<\\n' + r.story_raw + '\\n>>>';
return [{ json: { ...r, systemPrompt: ${JSON.stringify(STORY_SYSTEM)}, userPrompt: user } }];`

const storyRow = `// Відповідь моделі → рядок story_queue. Модель не відповіла — пишемо сиру розшифровку (історія не губиться)
const r = $('Code - Story Text').first().json;
let o = null;
try {
  const j = $json;
  const message = Array.isArray(j.output) ? j.output[0] : j;
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  o = JSON.parse(raw);
} catch (e) { o = null; }
const ids = new Set($('Supabase - Get Hotels').all().map(i => i.json.hotel_id).filter(Boolean));
const clean = o && typeof o.clean === 'string' && o.clean.trim().length > 20 ? o.clean.trim() : r.story_raw;
const row = {
  pillar: 'personal_experience',
  hotel_id: o && ids.has(o.hotel_id) ? o.hotel_id : null,
  destination: o && typeof o.destination === 'string' && o.destination.trim() ? o.destination.trim().slice(0, 120) : null,
  transcript_raw: r.story_raw,
  transcript_clean: clean,
  status: 'new',
};
const title = o && typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : clean.split(/\\s+/).slice(0, 6).join(' ') + '…';
return [{ json: { ...r, row, title, is_story: !(o && o.is_story === false) } }];`

const storySaved = `${esc}
const r = $('Code - Story Row').first().json;
const res = $json;
const ok = res.statusCode >= 200 && res.statusCode < 300;
if (!ok) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'Не вдалось записати історію 🙈 Перешли це голосове ще раз трохи згодом — або Владу.', url: r.mini_app_url, button: 'Відкрити TravelLab' } }];
return [{ json: { chat_id: r.chat_id, kind: 'button',
  text: 'Дякую! Записав історію ✅\\n«' + r.title + '»'
    + (r.is_story ? '' : '\\n\\n(Схоже, це не історія з поїздок — якщо випадково, скажи Владу, він прибере.)')
    + '\\n\\nВона піде в найближчий суботній пост — план тижня складаю в неділю ввечері. Текст побачиш в апці до публікації.',
  url: r.mini_app_url, button: 'Відкрити TravelLab' } }];`

const storyShort = `${esc}
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.story_url) + (r.story_raw ? 'Здається, історія обірвалась — розчув лише: «' + esc(r.story_raw) + '» 🙈' : 'Не вдалось розібрати голосове 🙈')
    + '\\n\\nЗапиши ще раз у відповідь на це повідомлення, будь ласка — хоча б кілька речень.'
} }];`

// ───── «🎙 Голос до відео» (сет 6) ─────
const voAsk = `${esc}
// /start vo_<id>: просимо голосове до цього відео (force_reply + прихований маркер — відповідь знає, до якого відео)
const r = $json;
const what = r.video.format === 'reel' ? 'рілсу' : 'сторіз';
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.vo_url) + '🎙 <b>Голос до ' + what + ' «' + esc(r.video.name) + '»</b>\\n\\n'
    + 'Запиши голосове на 15–30 с у відповідь на це повідомлення — своїми словами, ніби розповідаєш подрузі, що на відео. '
    + 'Не страшно, якщо будуть паузи чи «е-е» — я їх приберу.\\n\\n'
    + 'Далі сам: почищу звук, зроблю субтитри (виправиш в апці), підгоню кадри під голос, музика буде тихо на фоні.'
    + (r.video.has_voice ? '\\n\\nНовий голос замінить попередній.' : '')
} }];`

const voCheck = `${esc}
// Голосове до відео: лише голос / аудіо, 3–45 с → заявка воркеру; інакше — пояснюємо й чекаємо ще раз
const r = $json;
const a = r.audio;
let err = '';
if (!a) err = 'Потрібне саме голосове 🎙 — затисни мікрофон і запиши у відповідь на це повідомлення.';
else if (a.dur && a.dur < 3) err = 'Дуже коротко 🙈 Запиши 15–30 с, будь ласка.';
else if (a.dur > 45) err = 'Задовге (' + Math.round(a.dur) + ' с) — для рілсу треба до 45 с, краще 15–30. Запиши коротше, будь ласка.';
const now = new Date().toISOString();
const row = { remount: { kind: 'voice', file_id: a ? a.file_id : null, tg_dur: a ? a.dur : null, state: 'queued', at: now, by: Number(r.from_id) },
  status: 'ready_for_review', approved_at: null, approved_by: null,
  final_path: null, cover_path: null, rendered_at: null, render_error: null, tg_file_id: null, sent_at: null, sent_to: null, updated_at: now };
return [{ json: { ...r, ok: !err, err_text: err ? hidden(r.vo_url) + err : '', row } }];`

const voSaved = `// Заявку поставили → «монтую», кнопка прямо у відео; відео вже монтується → попросити пізніше
const r = $('Code - Video Voice Check').first().json;
const res = $json;
const ok = res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.body) && res.body.length > 0;
return [{ json: { chat_id: r.chat_id, kind: 'button', url: r.video_url, button: 'Відкрити відео',
  text: ok ? 'Отримав голос ✅ Монтую 1–2 хв: чищу звук, роблю субтитри, підганяю кадри під голос. Відкрий відео — побачиш, коли буде готово, і зможеш виправити слова в субтитрах.'
    : 'Зараз це відео саме монтується ⏳ Надішли голосове ще раз за хвилинку — у відповідь на моє повідомлення вище.' } }];`

// ───── «🎬 Відео» ─────
const INBOX_URL = 'https://drive.google.com/drive/folders/' + CFG.inboxId
const videoAsk = `// /video: куди кидати відео і що написати потім
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'link', url: ${JSON.stringify(INBOX_URL)}, button: '📂 Відкрити папку для відео',
  text: '🎬 Відео для рілс і сторіз\\n\\n'
    + 'Закинь відео в папку «00_Inbox» (кнопка нижче):\\n'
    + '• телефон: Google Диск → «+» → Завантажити → Фото й відео. Не закривай Диск, поки не завантажиться;\\n'
    + '• компʼютер: перетягни файли або цілу папку.\\n\\n'
    + 'Можна підпапкою з назвою готелю чи острова — так я швидше впізнаю місце. '
    + 'Не пересилай відео через Telegram/WhatsApp/Viber: вони стискають якість і стирають, де знято.\\n\\n'
    + 'Коли все завантажиться — повернись сюди й натисни «✅ Відео готово».'
} }];`

// Inbox → підпапки: другий запит бере і сам Inbox, і всі його підпапки (один рівень)
const videoQuery = `const files = Array.isArray($json.files) ? $json.files : [];
const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
const ids = [${JSON.stringify(CFG.inboxId)}, ...folders.map(f => f.id)];
return [{ json: { q: '(' + ids.map(id => "'" + id + "' in parents").join(' or ') + ') and trashed=false', folders: folders.map(f => ({ id: f.id, name: f.name })), list_error: $json.error ? String($json.error.message || $json.error).slice(0, 200) : '' } }];`

const videoSummary = `${esc}
// Підсумок Inbox: скільки відео, де, скільки місця; Владу — сигнал «можна розбирати» (HTML: назви папок екрануємо)
const r = $('Code - Resolve').first().json;
const q = $('Code - Video Query').first().json;
const files = (Array.isArray($json.files) ? $json.files : []).filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
const err = q.list_error || ($json.error ? String($json.error.message || $json.error).slice(0, 200) : '');
const names = Object.fromEntries(q.folders.map(f => [f.id, f.name]));
const videos = files.filter(f => String(f.mimeType || '').startsWith('video/'));
const photos = files.filter(f => String(f.mimeType || '').startsWith('image/'));
const other = files.length - videos.length - photos.length;
const gb = videos.reduce((s, f) => s + Number(f.size || 0), 0) / 1e9;
const by = {};
for (const f of videos) { const k = names[(f.parents || [])[0]] || ''; by[k] = (by[k] || 0) + 1; }
const lines = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, c]) => '• ' + (k ? '«' + esc(k) + '»' : 'без папки') + ' — ' + c);
const size = gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' ГБ' : Math.round(gb * 1000) + ' МБ';
const url = ${JSON.stringify(INBOX_URL)};
let text, admin = '';
if (err) text = 'Не вдалось відкрити папку з відео 🙈 Я передав Владу, він подивиться.';
else if (!videos.length) text = 'У папці поки немає відео 🤔\\n\\nЯкщо завантажувала з телефона — перевір, що завантаження закінчилось (Диск має бути відкритий до кінця). Потім знову натисни «✅ Відео готово».';
else text = 'Отримав ' + videos.length + ' відео (' + size + ') ✅\\n' + lines.join('\\n')
  + (photos.length ? '\\n\\nФото в цій папці (' + photos.length + ') поки не беру — фото поки що через бот завантаження фото (/upload).' : '')
  + '\\n\\nТепер я їх розберу: де знято, який готель чи острів, найкращі моменти. Перший рілс покаже Влад.';
if (err) admin = '⚠️ Іра написала «відео готово», але Inbox не відкрився: ' + esc(err);
else if (videos.length) admin = '🎬 Іра закинула ' + videos.length + ' відео (' + size + ') у 00_Inbox:\\n' + lines.join('\\n')
  + (photos.length ? '\\n+ фото: ' + photos.length : '') + (other > 0 ? '\\n+ інші файли: ' + other : '') + '\\n\\nМожна запускати розбір (Reels_Test_Plan §3).';
return [{ json: { chat_id: r.chat_id, kind: 'link', text, url, button: '📂 Відкрити папку для відео',
  admin_chat_id: r.admin_chat_id, admin_text: admin, notify_admin: !!admin && !!r.admin_chat_id && r.admin_chat_id !== r.chat_id } }];`

const driveList = (name, x, q, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, x, {
  url: 'https://www.googleapis.com/drive/v3/files',
  authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
  sendQuery: true,
  queryParameters: { parameters: [
    { name: 'q', value: q },
    { name: 'fields', value: 'files(id,name,mimeType,size,parents)' },
    { name: 'pageSize', value: '1000' },
  ] },
  options: {},
}, { credentials: { googleDriveOAuth2Api: CFG.drive }, onError: 'continueRegularOutput', executeOnce: true, ...extra })

const Y = 260
const coreNodes = [
  node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, 0, { inputSource: 'passthrough' }),
  node('Webhook - Test Update', 'n8n-nodes-base.webhook', 2, 0, { httpMethod: 'POST', path: 'travellab-bot-update-test', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
    { webhookId: '6b2f0d8e-91a4-4c7b-a3e5-tl-bot-update-test', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 200 }),
  node('Code - Normalize', 'n8n-nodes-base.code', 2, 220, { jsCode: normalize }),
  ifNode('IF - Anything?', 440, "={{ $json.route !== 'ignore' }}"),
  getAll('Supabase - Get Settings', 660, 'settings'),
  getAll('Supabase - Get Plans', 880, 'content_plan',
    "={{ $('Code - Normalize').first().json.plan_id ? 'id=eq.' + $('Code - Normalize').first().json.plan_id : 'review_status=eq.needs_data' }}"),
  getAll('Supabase - Get Open Requests', 1100, 'data_requests', 'status=eq.open', { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Hotels', 1320, 'hotels'),
  getAll('Supabase - Get Tours', 1540, 'tours'),
  getAll('Supabase - Get Audiences', 1650, 'audiences', null, { onError: 'continueRegularOutput', y: 200 }),
  // голос до відео (сет 6): чернетка за id з vo_<id>; інакше — запит-заглушка (порожньо)
  getAll('Supabase - Get Video Draft', 1700, 'video_drafts',
    "={{ 'id=eq.' + ($('Code - Normalize').first().json.video_id || '00000000-0000-0000-0000-000000000000') }}", { onError: 'continueRegularOutput', y: -200 }),
  node('Code - Resolve', 'n8n-nodes-base.code', 2, 1760, { jsCode: resolve }, { executeOnce: true }),
  node('Switch - Route', 'n8n-nodes-base.switch', 3.2, 1980, {
    rules: { values: ['ask', 'answer', 'help', 'unresolved', 'gone', 'story_ask', 'story', 'video_ask', 'video_ready', 'vo_ask', 'vo', 'vo_gone', 'vpub'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, combinator: 'and',
        conditions: [{ id: 'r-' + k, leftValue: '={{ $json.route }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }] },
      renameOutput: true, outputKey: k,
    })) },
    options: {},
  }),
  node('Code - Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: ask }, { y: -2 * Y }),
  node('Code - Simple Reply', 'n8n-nodes-base.code', 2, 2200, { jsCode: simple }, { y: 2 * Y }),
  ifNode('IF - Has Questions?', 2200, '={{ $json.questions.length > 0 }}'),
  ifNode('IF - Voice?', 2420, '={{ !!$json.file_id }}'),
  node('Telegram - Get Voice File', 'n8n-nodes-base.telegram', 1.2, 2640, { resource: 'file', operation: 'get', fileId: '={{ $json.file_id }}', download: true },
    { ...tgc, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('OpenAI - Transcribe', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2860, { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', options: { language: 'uk' } },
    { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('Code - Resolve Text', 'n8n-nodes-base.code', 2, 3080, { jsCode: resolveText }, { executeOnce: true }),
  ifNode('IF - Got Text?', 3300, '={{ !!$json.answer_text }}'),
  node('Code - Parse Prompt', 'n8n-nodes-base.code', 2, 3520, { jsCode: parsePrompt }),
  node('OpenAI - Parse Answers', '@n8n/n8n-nodes-langchain.openAi', 2.3, 3740, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput' }),
  node('Code - Parse Answers', 'n8n-nodes-base.code', 2, 3960, { jsCode: parseAnswers }, { executeOnce: true }),
  ifNode('IF - Any Answer?', 4180, '={{ $json.got.length > 0 }}'),
  node('Code - Not Heard', 'n8n-nodes-base.code', 2, 4400, { jsCode: notHeard }, { executeOnce: true, y: Y }),
  node('Code - Answer Items', 'n8n-nodes-base.code', 2, 4400, { jsCode: answerItems }, { executeOnce: true }),
  rest('HTTP - Save Answer', 4620, 'PATCH', '={{ $json.supabase_url }}/rest/v1/data_requests?id=eq.{{ $json.id }}&status=eq.open',
    "={{ JSON.stringify({ answer: $json.answer, status: 'answered', answered_via: 'voice_bot', answered_at: $now.toISO() }) }}", { prefer: 'return=representation' }),
  node('Code - After Save', 'n8n-nodes-base.code', 2, 4840, { jsCode: afterSave }, { executeOnce: true }),
  ifNode('IF - Claim?', 5060, '={{ $json.claim }}'),
  // «забрати» пост у роботу лише якщо його ніхто не змінив (статус і версія ті самі)
  rest('HTTP - Claim Plan', 5280, 'PATCH',
    "={{ $('Code - Parse Answers').first().json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $('Code - Parse Answers').first().json.plan.id }}&version_no=eq.{{ $('Code - Parse Answers').first().json.plan.version_no || 0 }}&review_status=in.(needs_data,ready_for_review,changes_requested)&published_at=is.null",
    "={{ JSON.stringify({ review_status: 'regenerating', review_note: null, updated_at: $now.toISO() }) }}", { prefer: 'return=representation', y: -Y }),
  node('Code - Claimed', 'n8n-nodes-base.code', 2, 5500, {
    jsCode: `const c = $json;\nconst ok = c.statusCode >= 200 && c.statusCode < 300 && Array.isArray(c.body) && c.body.length > 0;\nconst r = $('Code - After Save').first().json;\nreturn [{ json: { ...r, run: ok, text: ok ? r.text : r.text.replace('Дописую пост ✍️', 'Пост допишу трохи згодом.') } }];`,
  }, { executeOnce: true, y: -Y }),
  // спільна відповідь: force_reply (питання) або кнопка web_app
  node('Code - Reply', 'n8n-nodes-base.code', 2, 5720, { jsCode: `return [{ json: { run: false, ...$input.first().json } }];` }, { executeOnce: true }),
  ifNode('IF - Force Reply?', 5940, "={{ $json.kind === 'force' }}"),
  node('Telegram - Ask (force reply)', 'n8n-nodes-base.telegram', 1.2, 6160, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'forceReply', forceReply: { force_reply: true },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('Telegram - Reply (button)', 'n8n-nodes-base.telegram', 1.2, 6160, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false, disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y / 2 }),
  ifNode('IF - Run Data Answer?', 6380, "={{ $('Code - Reply').first().json.run === true }}"),
  node('Code - Data Answer Input', 'n8n-nodes-base.code', 2, 6600, { jsCode: runInput }, { executeOnce: true }),
  // «Розповісти історію» — окремий ряд нижче
  node('Code - Story Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: storyAsk }, { executeOnce: true, y: 4 * Y }),
  ifNode('IF - Story Voice?', 2200, '={{ !!$json.file_id }}', { y: 5 * Y }),
  node('Telegram - Get Story File', 'n8n-nodes-base.telegram', 1.2, 2420, { resource: 'file', operation: 'get', fileId: '={{ $json.file_id }}', download: true },
    { ...tgc, onError: 'continueRegularOutput', y: 5 * Y }),
  node('OpenAI - Transcribe Story', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2640, { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', options: { language: 'uk' } },
    { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: 5 * Y }),
  node('Code - Story Text', 'n8n-nodes-base.code', 2, 2860, { jsCode: storyText }, { executeOnce: true, y: 5 * Y }),
  ifNode('IF - Story Long Enough?', 3080, '={{ $json.long_enough }}', { y: 5 * Y }),
  node('Code - Story Too Short', 'n8n-nodes-base.code', 2, 3300, { jsCode: storyShort }, { executeOnce: true, y: 6 * Y }),
  node('Code - Story Prompt', 'n8n-nodes-base.code', 2, 3300, { jsCode: storyPrompt }, { executeOnce: true, y: 5 * Y }),
  node('OpenAI - Clean Story', '@n8n/n8n-nodes-langchain.openAi', 2.3, 3520, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: 5 * Y }),
  node('Code - Story Row', 'n8n-nodes-base.code', 2, 3740, { jsCode: storyRow }, { executeOnce: true, y: 5 * Y }),
  rest('HTTP - Insert Story', 3960, 'POST', "={{ $json.supabase_url }}/rest/v1/story_queue", '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 5 * Y }),
  node('Code - Story Saved', 'n8n-nodes-base.code', 2, 4180, { jsCode: storySaved }, { executeOnce: true, y: 5 * Y }),
  // «🎬 Відео» — ряд під історіями
  node('Code - Video Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: videoAsk }, { executeOnce: true, y: 7 * Y }),
  driveList('HTTP - List Inbox', 2200, "'" + CFG.inboxId + "' in parents and trashed=false", { y: 8 * Y }),
  node('Code - Video Query', 'n8n-nodes-base.code', 2, 2420, { jsCode: videoQuery }, { executeOnce: true, y: 8 * Y }),
  driveList('HTTP - List Inbox Files', 2640, '={{ $json.q }}', { y: 8 * Y }),
  node('Code - Video Summary', 'n8n-nodes-base.code', 2, 2860, { jsCode: videoSummary }, { executeOnce: true, y: 8 * Y }),
  ifNode('IF - Notify Admin?', 3080, '={{ $json.notify_admin }}', { y: 8 * Y }),
  node('Telegram - Notify Admin', 'n8n-nodes-base.telegram', 1.2, 3300, {
    chatId: '={{ $json.admin_chat_id }}', text: '={{ $json.admin_text }}',
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: 8 * Y }),
  node('Code - Video Reply', 'n8n-nodes-base.code', 2, 3520, { jsCode: `return [{ json: $('Code - Video Summary').first().json }];` }, { executeOnce: true, y: 8 * Y }),
  // «🎙 Голос до відео» — ряд під «Відео»
  node('Code - Video Voice Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: voAsk }, { executeOnce: true, y: 10 * Y }),
  node('Code - Video Voice Check', 'n8n-nodes-base.code', 2, 2200, { jsCode: voCheck }, { executeOnce: true, y: 11 * Y }),
  ifNode('IF - Voice OK?', 2420, '={{ $json.ok }}', { y: 11 * Y }),
  node('Code - Video Voice Retry', 'n8n-nodes-base.code', 2, 2640, {
    jsCode: `const r = $json;\nreturn [{ json: { chat_id: r.chat_id, kind: 'force', text: r.err_text } }];`,
  }, { executeOnce: true, y: 12 * Y }),
  // заявка лише якщо відео зараз не монтується (як IDLE у server/video.ts) і не «не публікувати»
  rest('HTTP - Queue Voice', 2640, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/video_drafts?id=eq.{{ $json.video.id }}&status=neq.skipped&or=(remount.is.null,remount->>state.in.(done,error))",
    '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 11 * Y }),
  node('Code - Video Voice Saved', 'n8n-nodes-base.code', 2, 2860, { jsCode: voSaved }, { executeOnce: true, y: 11 * Y }),
  // «✅ Виклала» — ряд під «Голос до відео»; позначаємо лише якщо ще не опубліковано
  rest('HTTP - Mark Posted', 2200, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/video_drafts?id=eq.{{ $json.video.id }}&published_at=is.null&status=eq.approved",
    '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 13 * Y }),
  node('Code - Posted Reply', 'n8n-nodes-base.code', 2, 2420, { jsCode: posted }, { executeOnce: true, y: 13 * Y }),
  ifNode('IF - Link?', 6160, "={{ $json.kind === 'link' }}", { y: Y * 1.5 }),
  node('Telegram - Reply (link)', 'n8n-nodes-base.telegram', 1.2, 6380, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { url: '={{ $json.url }}' } }] } },
      { row: { buttons: [{ text: '✅ Відео готово', additionalFields: { callback_data: 'video_ready' } }] } },
    ] },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y * 2 }),
  ifNode('IF - Menu?', 6380, "={{ $json.kind === 'menu' }}", { y: Y * 3 }),
  node('Telegram - Reply (menu)', 'n8n-nodes-base.telegram', 1.2, 6600, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [{ text: '📱 Відкрити TravelLab', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } },
      { row: { buttons: [{ text: '🎬 Завантажити відео', additionalFields: { callback_data: 'video_ask' } }] } },
      { row: { buttons: [{ text: '🎙 Розповісти історію', additionalFields: { callback_data: 'story' } }] } },
    ] },
    additionalFields: { appendAttribution: false, disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y * 4 }),
  ifNode('IF - Callback?', 550, '={{ !!$json.callback_id }}', { y: -Y }),
  node('Telegram - Answer Callback', 'n8n-nodes-base.telegram', 1.2, 600, { resource: 'callback', operation: 'answerQuery', queryId: '={{ $json.callback_id }}', additionalFields: {} },
    { ...tgc, onError: 'continueRegularOutput', y: -2 * Y }),
  node('Execute - Data Answer', 'n8n-nodes-base.executeWorkflow', 1.2, 6820, {
    source: 'database', workflowId: { __rl: true, value: CFG.dataAnswerId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
  }, { onError: 'continueRegularOutput' }),
]

const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const branches = (t, f) => ({ main: [[{ node: t, type: 'main', index: 0 }], f ? [{ node: f, type: 'main', index: 0 }] : []] })
const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, to(names[i + 1])]))
const coreConnections = {
  'Execute Workflow Trigger': to('Code - Normalize'),
  'Webhook - Test Update': to('Code - Normalize'),
  'Code - Normalize': to('IF - Anything?'),
  'IF - Anything?': branches('IF - Callback?'),
  'IF - Callback?': branches('Telegram - Answer Callback', 'Supabase - Get Settings'),
  'Telegram - Answer Callback': to('Supabase - Get Settings'),
  ...chain('Supabase - Get Settings', 'Supabase - Get Plans', 'Supabase - Get Open Requests', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Supabase - Get Audiences', 'Supabase - Get Video Draft', 'Code - Resolve', 'Switch - Route'),
  'Switch - Route': { main: [
    [{ node: 'Code - Ask', type: 'main', index: 0 }],
    [{ node: 'IF - Has Questions?', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Story Ask', type: 'main', index: 0 }],
    [{ node: 'IF - Story Voice?', type: 'main', index: 0 }],
    [{ node: 'Code - Video Ask', type: 'main', index: 0 }],
    [{ node: 'HTTP - List Inbox', type: 'main', index: 0 }],
    [{ node: 'Code - Video Voice Ask', type: 'main', index: 0 }],
    [{ node: 'Code - Video Voice Check', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'HTTP - Mark Posted', type: 'main', index: 0 }],
  ] },
  ...chain('HTTP - Mark Posted', 'Code - Posted Reply', 'Code - Reply'),
  'Code - Video Voice Ask': to('Code - Reply'),
  'Code - Video Voice Check': to('IF - Voice OK?'),
  'IF - Voice OK?': branches('HTTP - Queue Voice', 'Code - Video Voice Retry'),
  ...chain('HTTP - Queue Voice', 'Code - Video Voice Saved', 'Code - Reply'),
  'Code - Video Voice Retry': to('Code - Reply'),
  'Code - Video Ask': to('Code - Reply'),
  ...chain('HTTP - List Inbox', 'Code - Video Query', 'HTTP - List Inbox Files', 'Code - Video Summary', 'IF - Notify Admin?'),
  'IF - Notify Admin?': branches('Telegram - Notify Admin', 'Code - Video Reply'),
  ...chain('Telegram - Notify Admin', 'Code - Video Reply', 'Code - Reply'),
  'IF - Story Voice?': branches('Telegram - Get Story File', 'Code - Story Text'),
  ...chain('Telegram - Get Story File', 'OpenAI - Transcribe Story', 'Code - Story Text', 'IF - Story Long Enough?'),
  'IF - Story Long Enough?': branches('Code - Story Prompt', 'Code - Story Too Short'),
  ...chain('Code - Story Prompt', 'OpenAI - Clean Story', 'Code - Story Row', 'HTTP - Insert Story', 'Code - Story Saved', 'Code - Reply'),
  'Code - Story Ask': to('Code - Reply'),
  'Code - Story Too Short': to('Code - Reply'),
  'IF - Has Questions?': branches('IF - Voice?', 'Code - Simple Reply'),
  'IF - Voice?': branches('Telegram - Get Voice File', 'Code - Resolve Text'),
  ...chain('Telegram - Get Voice File', 'OpenAI - Transcribe', 'Code - Resolve Text', 'IF - Got Text?'),
  'IF - Got Text?': branches('Code - Parse Prompt', 'Code - Not Heard'),
  ...chain('Code - Parse Prompt', 'OpenAI - Parse Answers', 'Code - Parse Answers', 'IF - Any Answer?'),
  'IF - Any Answer?': branches('Code - Answer Items', 'Code - Not Heard'),
  ...chain('Code - Answer Items', 'HTTP - Save Answer', 'Code - After Save', 'IF - Claim?'),
  'IF - Claim?': branches('HTTP - Claim Plan', 'Code - Reply'),
  ...chain('HTTP - Claim Plan', 'Code - Claimed', 'Code - Reply'),
  'Code - Ask': to('Code - Reply'),
  'Code - Simple Reply': to('Code - Reply'),
  'Code - Not Heard': to('Code - Reply'),
  'Code - Reply': to('IF - Force Reply?'),
  'IF - Force Reply?': branches('Telegram - Ask (force reply)', 'IF - Link?'),
  'IF - Link?': branches('Telegram - Reply (link)', 'IF - Menu?'),
  'IF - Menu?': branches('Telegram - Reply (menu)', 'Telegram - Reply (button)'),
  'Telegram - Reply (button)': to('IF - Run Data Answer?'),
  'IF - Run Data Answer?': branches('Code - Data Answer Input'),
  'Code - Data Answer Input': to('Execute - Data Answer'),
}
const core = { name: '[TravelLab] Voice Answers (Mini App)', nodes: coreNodes, connections: coreConnections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }

// ───── Бот: Telegram Trigger → ядро (НЕАКТИВНИЙ, див. шапку) ─────
const botWf = (coreId) => ({
  name: '[TravelLab] Ira Bot (updates)',
  nodes: [
    node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, 0, { updates: ['message', 'callback_query'], additionalFields: {} }, { ...tgc, webhookId: '0e7c4b19-5a2d-4f3e-8c61-tl-ira-bot' }),
    node('Execute - Voice Answers', 'n8n-nodes-base.executeWorkflow', 1.2, 220, {
      source: 'database', workflowId: { __rl: true, value: coreId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
    }, { onError: 'continueRegularOutput' }),
  ],
  connections: { 'Telegram Trigger': to('Execute - Voice Answers') },
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
})

const CORE_ID = process.env.TL_VOICE_CORE_ID || 'rq6TbVhPdhaaHx4k'
writeFileSync(join(here, 'voice_answers.json'), JSON.stringify(core, null, 2))
writeFileSync(join(here, 'ira_bot.json'), JSON.stringify(botWf(CORE_ID), null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', coreNodes.length, 'nodes → n8n/voice_answers.json + n8n/ira_bot.json')
else {
  const mcp = JSON.parse(readFileSync(join(here, '..', '..', '..', '.mcp.json'), 'utf8'))
  const env = (mcp.mcpServers || mcp)['n8n-mcp'].env
  const base = env.N8N_API_URL.replace(/\/$/, '')
  const api = base.endsWith('/api/v1') ? base : base + '/api/v1'
  const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' }
  const send = async (id, wf) => {
    const r = await fetch(id ? `${api}/workflows/${id}` : `${api}/workflows`, { method: id ? 'PUT' : 'POST', headers, body: JSON.stringify(wf) })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch {}
    console.log(r.status, j ? `${j.id} ${j.name} active=${j.active}` : t.slice(0, 500))
    return j
  }
  if (mode === 'create') {
    const c = await send(null, core)
    if (c?.id) await send(null, botWf(c.id))
  } else if (mode === 'update') {
    await send(process.argv[3], core)
    if (process.argv[4]) await send(process.argv[4], botWf(process.argv[3]))
  }
}

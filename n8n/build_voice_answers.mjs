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
// Не reply (просто голосове) → якщо в «бракує даних» рівно один пост — до нього, інакше просимо відповісти на питання.
import { readFileSync, writeFileSync } from 'node:fs'
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
const b = $json.body && typeof $json.body === 'object' && ($json.body.message || $json.body.update_id) ? $json.body : $json;
const m = b.message || {};
const text = String(m.text || m.caption || '').trim();
const file = (m.voice && m.voice.file_id) || (m.audio && m.audio.file_id) || (m.video_note && m.video_note.file_id) || null;
let planId = null, how = 'none';
const st = text.match(/^\\/start(?:@\\w+)?\\s+answer_([0-9a-f-]{36})\\b/i);
if (st) { planId = st[1].toLowerCase(); how = 'start'; }
const r = m.reply_to_message;
if (!planId && r) {
  for (const e of [...(r.entities || []), ...(r.caption_entities || [])]) {
    const mm = String(e.url || '').match(/post_([0-9a-f-]{36})/i);
    if (mm) { planId = mm[1].toLowerCase(); how = 'reply'; break; }
  }
}
let route = 'ignore';
if (!m.chat || !m.from || m.from.is_bot) route = 'ignore';
else if (st) route = 'ask';
else if (file || (text && how === 'reply')) route = 'answer';
else if (text) route = 'help';
return [{ json: { route, plan_id: planId, how, chat_id: m.chat ? String(m.chat.id) : '', from_id: m.from ? String(m.from.id) : '', text: file ? '' : text, file_id: file } }];`

const resolve = `// Хто пише (лише Іра / Влад), до якого поста, які відкриті питання
const n = $('Code - Normalize').first().json;
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const s = {};
for (const r of all('Supabase - Get Settings')) s[r.key] = r.value;
const allowed = [s.ira_chat_id, s.admin_chat_id].filter(Boolean).map(String);
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
const out = { ...n, mini_app_url: base, supabase_url: String(s.supabase_url || '').replace(/\\/$/, '') };
if (n.route === 'ignore' || !allowed.includes(n.from_id)) return [{ json: { ...out, route: 'ignore' } }];

const reqs = all('Supabase - Get Open Requests');
const forPlan = (p) => reqs.filter(q => q.content_plan_id === p.id || (p.hotel_id && q.hotel_id === p.hotel_id) || (p.tour_id && q.tour_id === p.tour_id))
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const plans = all('Supabase - Get Plans');
let plan = n.plan_id ? plans.find(p => p.id === n.plan_id) || null : null;
if (!plan && !n.plan_id && n.route === 'answer') {
  // просто голосове, не відповідь на питання: якщо «бракує даних» рівно в одному пості — до нього
  const c = plans.filter(p => p.review_status === 'needs_data' && !p.published_at && forPlan(p).length);
  if (c.length === 1) plan = c[0];
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
  help: 'Пости на перегляд — у TravelLab (кнопка нижче). Щоб відповісти голосом на питання агента, відкрий пост і натисни «Відповісти голосом».',
  unresolved: 'Не зрозумів, до якого поста ця відповідь 🙈 Відкрий пост у TravelLab і натисни «Відповісти голосом» — я поставлю питання ще раз.',
  gone: 'Цього поста вже немає в роботі 🙌',
  none: 'По цьому посту питань уже немає 🙌'
};
const k = r.route === 'answer' ? 'none' : r.route;
return [{ json: { chat_id: r.chat_id, kind: 'button', text: T[k] || T.help, url: (k === 'none' && r.post_url) || r.mini_app_url, button: k === 'none' ? 'Повернутись у TravelLab' : 'Відкрити TravelLab' } }];`

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
  node('Code - Resolve', 'n8n-nodes-base.code', 2, 1760, { jsCode: resolve }, { executeOnce: true }),
  node('Switch - Route', 'n8n-nodes-base.switch', 3.2, 1980, {
    rules: { values: ['ask', 'answer', 'help', 'unresolved', 'gone'].map((k) => ({
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
  'IF - Anything?': branches('Supabase - Get Settings'),
  ...chain('Supabase - Get Settings', 'Supabase - Get Plans', 'Supabase - Get Open Requests', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Code - Resolve', 'Switch - Route'),
  'Switch - Route': { main: [
    [{ node: 'Code - Ask', type: 'main', index: 0 }],
    [{ node: 'IF - Has Questions?', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
  ] },
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
  'IF - Force Reply?': branches('Telegram - Ask (force reply)', 'Telegram - Reply (button)'),
  'Telegram - Reply (button)': to('IF - Run Data Answer?'),
  'IF - Run Data Answer?': branches('Code - Data Answer Input'),
  'Code - Data Answer Input': to('Execute - Data Answer'),
}
const core = { name: '[TravelLab] Voice Answers (Mini App)', nodes: coreNodes, connections: coreConnections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }

// ───── Бот: Telegram Trigger → ядро (НЕАКТИВНИЙ, див. шапку) ─────
const botWf = (coreId) => ({
  name: '[TravelLab] Ira Bot (updates)',
  nodes: [
    node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, 0, { updates: ['message'], additionalFields: {} }, { ...tgc, webhookId: '0e7c4b19-5a2d-4f3e-8c61-tl-ira-bot' }),
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

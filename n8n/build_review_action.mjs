// node n8n/build_review_action.mjs [dump|create|update <id>]
// Збирає n8n-воркфлоу «[TravelLab] Review Action (Mini App)»: правка Іри з апки → Post Generator → нова версія → бот Іри.
// dump — лише n8n/review_action.json (для імпорту на інший n8n при переносі на акаунти Іри).
// ID credentials/генератора — константи нижче; при переносі міняються тут (і більше ніде).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  // Telegram credential бота Іри (@travellab_studio_bot), створено 08.10
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  // Тестовий генератор з PRMPT-011 v4; після апруву Іри → WF-043 rmfe3WbNRAOGUfqS
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  // TL_TEST=1 → тестова копія з іншим шляхом вебхука (прод не чіпаємо)
  test: process.env.TL_TEST === '1',
}

const sb = { supabaseApi: CFG.supabase }
const node = (name, type, typeVersion, x, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, extra.y ?? 0], parameters, ...extra, y: undefined })
const getAll = (name, x, table, conditions, extra = {}) =>
  node(name, 'n8n-nodes-base.supabase', 1, x, {
    operation: 'getAll', tableId: table, returnAll: true,
    ...(conditions ? { filterType: 'manual', matchType: 'allFilters', filters: { conditions } } : {}),
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, ...extra })
const eq = (keyName, keyValue) => ({ keyName, condition: 'eq', keyValue })

const buildInput = `// Збирає вхід для Post Generator з плану, поточної версії і нових правок Іри
const body = $('Webhook').first().json.body || {};
const all = (n) => { try { return $(n).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0); } catch (e) { return []; } };
const plan = all('Supabase - Get Plan')[0];
if (!plan) throw new Error('content_plan не знайдено: ' + body.content_plan_id);
const versions = all('Supabase - Get Versions').sort((a, b) => a.version_no - b.version_no);
const cur = versions.find(v => v.id === plan.current_version_id) || versions[versions.length - 1] || null;
const comments = all('Supabase - Get Comments').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const fresh = comments.filter(c => c.status === 'new');
const textNew = fresh.filter(c => c.target === 'text');
const photoNew = fresh.filter(c => c.target === 'photo');
const earlier = comments.filter(c => c.status === 'applied' && c.target === 'text').map(c => '— ' + c.body);

const hotels = all('Supabase - Get Hotels');
const tours = all('Supabase - Get Tours');
const stories = all('Supabase - Get Stories');
const CUTOVER = new Date('2026-09-19T12:00:00Z');
const fewshot = all('Supabase - Get Approved Posts').filter(p => p.content && p.created_at && new Date(p.created_at) >= CUTOVER);

// Точкова правка (за замовчуванням) vs повна переробка генератором — лише коли Іра прямо просить переписати
const REWRITE = /перепиш|інш(ий|у|е) варіант|з нуля|заново|по-новому|повністю переро/i;
const editMode = !textNew.some(c => REWRITE.test(c.body));

let feedback = textNew.map(c => c.body).join('\\n');
if (feedback && earlier.length) feedback += '\\n\\nРаніше Іра вже просила по цьому посту (не повертай того, що вона прибрала):\\n' + earlier.join('\\n');

return [{ json: {
  _skip_text: textNew.length === 0,
  _plan: plan,
  _cur: cur,
  _text_comment_ids: textNew.map(c => c.id),
  _photo_comment_ids: photoNew.map(c => c.id),
  // «Нова версія готова» — тому, хто просив правку (Іра або Влад на тесті)
  _author_tg_id: (fresh[fresh.length - 1] || {}).author_tg_id || null,
  _expected_version_no: Number(body.expected_version_no ?? plan.version_no),
  _edit_mode: editMode,
  _edit_request: textNew.map(c => c.body).join('\\n\\n'),
  _earlier_raw: comments.filter(c => c.status === 'applied' && c.target === 'text').map(c => c.body),
  mode: 'regenerate',
  slot: { day: plan.day, platform: plan.platform, slot_type: plan.slot_type, pillar: plan.pillar },
  week_parity: DateTime.now().weekNumber % 2 === 0 ? 'even' : 'odd',
  tour: tours.find(t => t.tour_id === plan.tour_id) || null,
  hotel: hotels.find(h => h.hotel_id === plan.hotel_id) || null,
  story: stories.find(s => s.id === plan.story_id) || null,
  fewshot,
  old_text: cur ? cur.text : '',
  ira_feedback: feedback,
  had_feedback: !!feedback,
  passthrough: { content_plan_id: plan.id }
} }];`

const parseResult = `// Результат генератора → рядок post_versions (або помилка)
const g = $json;
const ctx = $('Code - Build Generator Input').first().json;
const cur = ctx._cur || {};
const ok = !!(g && g.status && g.status !== 'failed' && g.text);
const lintErr = (g && g.lint_errors) || [];
return [{ json: {
  _ok: ok,
  _error: ok ? '' : String((g && (g.error || g.status)) || 'генератор не повернув текст').slice(0, 300),
  _plan_id: ctx._plan.id,
  _expected_version_no: ctx._expected_version_no,
  _text_comment_ids: ctx._text_comment_ids,
  row: ok ? {
    content_plan_id: ctx._plan.id,
    version_no: ctx._plan.version_no + 1,
    text_v: (cur.text_v || 0) + 1,
    image_v: cur.image_v || 0,
    text: g.text,
    hooks: Array.isArray(g.hooks) && g.hooks.length ? g.hooks : null,
    form: g.form || null,
    key_idea: g.key_idea || null,
    media_ids: cur.media_ids || [],
    rendered_urls: cur.rendered_urls || [],
    render_params: cur.render_params || {},
    trigger: 'comment',
    comment_id: ctx._text_comment_ids[0] || null,
    model: 'gpt-4.1',
    prompt_version: g._edit ? 'EDIT v1' : 'PRMPT-011 v4',
    lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : []
  } : null
} }];`

const rowOnly = `return [{ json: $json.row }];`

// ───── Точкова правка: змінити лише те, що просить Іра; решта — слово в слово. Без лінтера й без примусового CTA ─────
const EDIT_SYSTEM = [
  'Ти — уважний редактор постів Ірини (TravelLab, luxury travel). Тобі дають ГОТОВИЙ пост і її правку.',
  'Головне правило: зміни ЛИШЕ те, про що вона просить. Усе, чого правка не стосується, лишається символ у символ: ті самі слова, порядок, абзаци, переноси рядків, емодзі, посилання, **жирний**.',
  'Правила:',
  '1. Не переписуй, не «покращуй», не перефразовуй і не додавай від себе нічого, про що вона не просила.',
  '2. Якщо вона дає готовий текст або фразу — встав її ДОСЛІВНО (можна лише виправити очевидну одруківку). «Постав мій текст» = весь пост дорівнює її тексту.',
  '3. «Прибери X» — прибери X і нічого більше. Посилання/стрілки/@ — прибирай, якщо просить; сам НЕ додавай нових посилань.',
  '4. Нові факти — лише якщо вона прямо просить додати факти/деталі, і ТІЛЬКИ з блоку «Факти про готель». Не вигадуй.',
  '5. Стильові правки — працюй з ІСНУЮЧИМИ реченнями, НЕ додаючи нових фактів і вражень. «Коротше» = викресли зайве (слова, підрядні, повтори), не перефразовуючи решту. «Тепліше / більше мене» = змінити тон 1–3 речень (живіші слова, звертання, «я раджу», «мені подобається») — без нових подій, людей і деталей. Щонайменше половина речень лишається без жодної зміни.',
  '5а. Абзаци й переноси рядків зберігай ЗАВЖДИ (не зливай абзаци в один).',
  '6. Останній рядок / фразу з датами, ціною, контактом (@…) не чіпай, якщо правка прямо не про них.',
  '7. НІКОЛИ не вигадуй особистого: діти, чоловік, «ми з …», «разом з дитиною», «я відчула». «Нотатки Ірини» і «Факти» використовуй ЛИШЕ коли правка прямо просить додати деталь / враження / факт — і тоді беріть рівно те, про що просить, не більше.',
  '8. Не додавай критики й мінусів («це не сюди», «не для вас», «якщо шукаєте тишу…»), рекламних штампів («рідкість», «найкращий», «розкішний», «незабутній», «ідеально»).',
  '9. Фрази, які Ірина написала сама (блок «Її власні формулювання»), лишай дослівно, якщо нова правка прямо не просить їх змінити.',
  '10. Якщо правка незрозуміла або суперечить сама собі — зроби найменшу безпечну зміну.',
  'Відповідь — СТРОГО JSON без іншого тексту: {"text": "повний текст поста після правки", "changed": "одне коротке речення українською: що саме змінено"}'
].join('\n');

const editPrompt = `// Промпт для точкової правки
const ctx = $('Code - Build Generator Input').first().json;
const h = ctx.hotel || {};
const facts = [h.name, h.key_detail, h.who_for, h.caveat && ('Нюанс: ' + h.caveat)].filter(Boolean).join('\\n');
// Її власні формулювання = довгі шматки тексту з попередніх правок, які зараз є в пості
const own = (ctx._earlier_raw || []).flatMap(b => String(b).split(/\\n+/)).map(x => x.trim()).filter(x => x.length >= 30 && (ctx.old_text || '').includes(x));
const user = 'ПОСТ ЗАРАЗ:\\n<<<\\n' + (ctx.old_text || '') + '\\n>>>\\n\\nПРАВКА ІРИНИ:\\n<<<\\n' + ctx._edit_request + '\\n>>>'
  + '\\n\\nЇї власні формулювання (не змінювати):\\n' + (own.length ? own.map(x => '— ' + x).join('\\n') : '—')
  + '\\n\\nФакти про готель (лише якщо правка просить додати деталі):\\n' + (facts || '—')
  + '\\n\\nНотатки Ірини (єдине джерело особистого):\\n' + (h.ira_notes || '—');
return [{ json: { systemPrompt: ${JSON.stringify(EDIT_SYSTEM)}, userPrompt: user } }];`

const parseEdit = `// Відповідь редактора → у форматі виходу генератора (далі — спільний Code - Parse Result)
const ctx = $('Code - Build Generator Input').first().json;
const cur = ctx._cur || {};
let out = null;
try {
  const message = Array.isArray($json.output) ? $json.output[0] : (Array.isArray($json) ? $json[0] : $json);
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || $json.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  out = JSON.parse(raw);
} catch (e) { out = null; }
const text = out && typeof out.text === 'string' ? out.text.trim() : '';
if (!text) return [{ json: { status: 'failed', error: 'редактор не повернув текст' } }];
return [{ json: { status: 'ok', _edit: true, text, changed: String(out.changed || ''), hooks: cur.hooks || null, form: cur.form || null, key_idea: cur.key_idea || null, lint_errors: [] } }];`

const message = `// Текст для бота Іри + кнопка, що відкриває саме цей пост в апці
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const ctx = $('Code - Build Generator Input').first().json;
const plan = ctx._plan;
const ok = $('Code - Parse Result').first().json._ok;
const plat = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }[plan.platform] || plan.platform;
const title = (ctx.hotel && ctx.hotel.name) || (ctx.tour && ctx.tour.title) || plan.pillar;
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
return [{ json: {
  chat_id: String(ctx._author_tg_id || s.ira_chat_id || s.admin_chat_id || ''),
  admin_chat_id: String(s.admin_chat_id || ''),
  text: ok ? '✨ Нова версія готова\\n' + title + ' · ' + plat + '\\n\\nГлянеш?' : '',
  url: base ? base + '/?startapp=post_' + plan.id : '',
  fail_text: ok ? '' : '⚠️ Review Action: не вдалось переробити пост ' + plan.id + ' (' + title + ' · ' + plat + '): ' + $('Code - Parse Result').first().json._error
} }];`

const tgCreds = CFG.telegram ? { credentials: { telegramApi: CFG.telegram } } : {}

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, {
    httpMethod: 'POST', path: CFG.test ? 'travellab-review-action-test' : 'travellab-review-action', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {},
  }, { webhookId: CFG.test ? '5f0c2b7e-7a1d-4c55-9b0e-tl-review-test' : '5f0c2b7e-7a1d-4c55-9b0e-tl-review-action', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  getAll('Supabase - Get Plan', 220, 'content_plan', [eq('id', "={{ $json.body.content_plan_id }}")]),
  getAll('Supabase - Get Versions', 440, 'post_versions', [eq('content_plan_id', "={{ $('Webhook').first().json.body.content_plan_id }}")]),
  getAll('Supabase - Get Comments', 660, 'review_comments', [eq('content_plan_id', "={{ $('Webhook').first().json.body.content_plan_id }}")]),
  getAll('Supabase - Get Hotels', 880, 'hotels'),
  getAll('Supabase - Get Tours', 1100, 'tours'),
  getAll('Supabase - Get Stories', 1320, 'story_queue'),
  getAll('Supabase - Get Approved Posts', 1540, 'posts'),
  node('Code - Build Generator Input', 'n8n-nodes-base.code', 2, 1760, { jsCode: buildInput }),
  node('IF - Text Comments?', 'n8n-nodes-base.if', 2.2, 1980, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'has-text', leftValue: '={{ $json._skip_text }}', rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }] },
    options: {},
  }),
  node('IF - Edit Mode?', 'n8n-nodes-base.if', 2.2, 2090, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'edit-mode', leftValue: '={{ $json._edit_mode }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }, { y: -220 }),
  node('Code - Build Edit Prompt', 'n8n-nodes-base.code', 2, 2200, { jsCode: editPrompt }, { y: -220 }),
  node('OpenAI - Apply Edit', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2310, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: -220 }),
  node('Code - Parse Edit', 'n8n-nodes-base.code', 2, 2420, { jsCode: parseEdit }, { y: -220 }),
  node('Execute - Post Generator', 'n8n-nodes-base.executeWorkflow', 1.2, 2200, {
    source: 'database', workflowId: { __rl: true, value: CFG.generatorId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput' }),
  node('Code - Parse Result', 'n8n-nodes-base.code', 2, 2420, { jsCode: parseResult }),
  node('IF - Generated?', 'n8n-nodes-base.if', 2.2, 2640, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'gen-ok', leftValue: '={{ $json._ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }),
  node('Code - Version Row', 'n8n-nodes-base.code', 2, 2860, { jsCode: rowOnly }),
  node('Supabase - Insert Version', 'n8n-nodes-base.supabase', 1, 3080, { operation: 'create', tableId: 'post_versions', dataToSend: 'autoMapInputData' }, { credentials: sb }),
  node('Supabase - Point Plan To Version', 'n8n-nodes-base.supabase', 1, 3300, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('id', '={{ $json.content_plan_id }}'), eq('version_no', "={{ $('Code - Parse Result').first().json._expected_version_no }}")] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [
      { fieldId: 'current_version_id', fieldValue: '={{ $json.id }}' },
      { fieldId: 'version_no', fieldValue: '={{ $json.version_no }}' },
      { fieldId: 'review_status', fieldValue: 'ready_for_review' },
      { fieldId: 'updated_at', fieldValue: '={{ $now.toISO() }}' },
    ] },
  }, { credentials: sb, alwaysOutputData: true }),
  node('Supabase - Mark Comments Applied', 'n8n-nodes-base.supabase', 1, 3520, {
    operation: 'update', tableId: 'review_comments', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('content_plan_id', "={{ $('Code - Parse Result').first().json._plan_id }}"), eq('status', 'new'), eq('target', 'text')] },
    dataToSend: 'defineBelow', fieldsUi: { fieldValues: [{ fieldId: 'status', fieldValue: 'applied' }] },
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true }),
  node('Supabase - Back To Changes Requested', 'n8n-nodes-base.supabase', 1, 2860, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('id', "={{ $('Code - Build Generator Input').first().json._plan.id }}"), eq('review_status', 'regenerating')] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [{ fieldId: 'review_status', fieldValue: 'changes_requested' }, { fieldId: 'review_note', fieldValue: "={{ $json._error || 'правка лише до фото — чекає фото-треку (фаза 6)' }}" }] },
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, y: 220 }),
  getAll('Supabase - Get Settings', 3740, 'settings'),
  node('Code - Message', 'n8n-nodes-base.code', 2, 3960, { jsCode: message }),
  node('Telegram - New Version To Ira', 'n8n-nodes-base.telegram', 1.2, 4180, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Подивитись', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false },
  }, { ...tgCreds, onError: 'continueRegularOutput' }),
]

// Гілка помилки / лише фото-правки: статус назад + Владу в бот (якщо є Telegram credential)
nodes.push(
  getAll('Supabase - Get Settings (fail)', 3080, 'settings', null, { y: 220 }),
  node('Code - Fail Message', 'n8n-nodes-base.code', 2, 3300, { jsCode: message.replace(/Supabase - Get Settings'/, "Supabase - Get Settings (fail)'").replace("const ok = $('Code - Parse Result').first().json._ok;", "let ok = false; try { ok = $('Code - Parse Result').first().json._ok; } catch (e) {}").replace("$('Code - Parse Result').first().json._error", "(() => { try { return $('Code - Parse Result').first().json._error; } catch (e) { return 'лише фото-правка'; } })()") }, { y: 220 }),
  node('Telegram - Fail To Admin', 'n8n-nodes-base.telegram', 1.2, 3520, {
    chatId: '={{ $json.admin_chat_id }}', text: '={{ $json.fail_text }}', additionalFields: { appendAttribution: false },
  }, { ...tgCreds, onError: 'continueRegularOutput', y: 220 }),
)

const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const connections = {
  ...chain('Webhook', 'Supabase - Get Plan', 'Supabase - Get Versions', 'Supabase - Get Comments', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Supabase - Get Stories', 'Supabase - Get Approved Posts', 'Code - Build Generator Input', 'IF - Text Comments?'),
  'IF - Text Comments?': { main: [[{ node: 'IF - Edit Mode?', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Changes Requested', type: 'main', index: 0 }]] },
  'IF - Edit Mode?': { main: [[{ node: 'Code - Build Edit Prompt', type: 'main', index: 0 }], [{ node: 'Execute - Post Generator', type: 'main', index: 0 }]] },
  ...chain('Code - Build Edit Prompt', 'OpenAI - Apply Edit', 'Code - Parse Edit', 'Code - Parse Result'),
  ...chain('Execute - Post Generator', 'Code - Parse Result', 'IF - Generated?'),
  'IF - Generated?': { main: [[{ node: 'Code - Version Row', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Changes Requested', type: 'main', index: 0 }]] },
  ...chain('Code - Version Row', 'Supabase - Insert Version', 'Supabase - Point Plan To Version', 'Supabase - Mark Comments Applied', 'Supabase - Get Settings', 'Code - Message', 'Telegram - New Version To Ira'),
  ...chain('Supabase - Back To Changes Requested', 'Supabase - Get Settings (fail)', 'Code - Fail Message', 'Telegram - Fail To Admin'),
}

for (const n of nodes) delete n.y
const wf = {
  name: (CFG.test ? '[TEST] ' : '') + '[TravelLab] Review Action (Mini App)',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
}
if (!CFG.test) writeFileSync(join(here, 'review_action.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/review_action.json')
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

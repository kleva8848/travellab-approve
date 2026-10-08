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
  // Telegram credential бота Іри (@travellab_studio_bot) — створює Влад; поки немає, Telegram-ноди без credential
  telegram: process.env.TL_TG_CRED_ID ? { id: process.env.TL_TG_CRED_ID, name: 'TravelLab Ira Bot' } : null,
  // Тестовий генератор з PRMPT-011 v4; після апруву Іри → WF-043 rmfe3WbNRAOGUfqS
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
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

let feedback = textNew.map(c => c.body).join('\\n');
if (feedback && earlier.length) feedback += '\\n\\nРаніше Іра вже просила по цьому посту (не повертай того, що вона прибрала):\\n' + earlier.join('\\n');

return [{ json: {
  _skip_text: textNew.length === 0,
  _plan: plan,
  _cur: cur,
  _text_comment_ids: textNew.map(c => c.id),
  _photo_comment_ids: photoNew.map(c => c.id),
  _expected_version_no: Number(body.expected_version_no ?? plan.version_no),
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
    prompt_version: 'PRMPT-011 v4',
    lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : []
  } : null
} }];`

const rowOnly = `return [{ json: $json.row }];`

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
  chat_id: String(s.ira_chat_id || s.admin_chat_id || ''),
  admin_chat_id: String(s.admin_chat_id || ''),
  text: ok ? '✨ Нова версія готова\\n' + title + ' · ' + plat + '\\n\\nГлянеш?' : '',
  url: base ? base + '/?startapp=post_' + plan.id : '',
  fail_text: ok ? '' : '⚠️ Review Action: не вдалось переробити пост ' + plan.id + ' (' + title + ' · ' + plat + '): ' + $('Code - Parse Result').first().json._error
} }];`

const tgCreds = CFG.telegram ? { credentials: { telegramApi: CFG.telegram } } : {}

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, {
    httpMethod: 'POST', path: 'travellab-review-action', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {},
  }, { webhookId: '5f0c2b7e-7a1d-4c55-9b0e-tl-review-action', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
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
  'IF - Text Comments?': { main: [[{ node: 'Execute - Post Generator', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Changes Requested', type: 'main', index: 0 }]] },
  ...chain('Execute - Post Generator', 'Code - Parse Result', 'IF - Generated?'),
  'IF - Generated?': { main: [[{ node: 'Code - Version Row', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Changes Requested', type: 'main', index: 0 }]] },
  ...chain('Code - Version Row', 'Supabase - Insert Version', 'Supabase - Point Plan To Version', 'Supabase - Mark Comments Applied', 'Supabase - Get Settings', 'Code - Message', 'Telegram - New Version To Ira'),
  ...chain('Supabase - Back To Changes Requested', 'Supabase - Get Settings (fail)', 'Code - Fail Message', 'Telegram - Fail To Admin'),
}

for (const n of nodes) delete n.y
const wf = {
  name: '[TravelLab] Review Action (Mini App)',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
}
writeFileSync(join(here, 'review_action.json'), JSON.stringify(wf, null, 2))

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

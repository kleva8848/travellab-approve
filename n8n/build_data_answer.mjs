// node n8n/build_data_answer.mjs [dump|create|update <id>]
// «[TravelLab] Data Answer (Mini App)»: Іра відповіла на питання агента («бракує даних») → факти в досьє → пост дописано.
// Хто кличе: апка (/api/review answer_data → вебхук travellab-data-answer, Header Auth) і голос через бот
// (Voice Answers → Execute Workflow). На вході пост уже в 'regenerating', відповіді — у data_requests (status answered).
// Вхід: { content_plan_id, expected_version_no, author_tg_id, via: 'text'|'voice_bot', prev_status? }
// Кроки: відповіді про готель → sub-WF Hotel Fact Write (досьє hotels + hotel_insights, mode append; ціна — replace);
//   про тур → PATCH tours; тема / дати поста → у вхід генератора. Далі Post Generator (той самий, що WF-046 / Buffer Filler,
//   ⭐ few-shot, правила) → фото (tl_pick_media, якщо в пості ще нема) → tl_add_version (trigger data_answer) →
//   data_requests 'applied' → «✨ Нова версія готова» тому, хто відповідав (web_app-кнопка на пост).
// Не вийшло → пост назад у попередній статус (needs_data), відповіді лишаються 'answered' (їх візьме Buffer Filler) + Владу.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  // як у WF-046 / Buffer Filler; після апруву Іри → TL_GENERATOR_ID=rmfe3WbNRAOGUfqS (WF-043)
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
  // [TravelLab] Hotel Fact Write (sub) — n8n/build_hotel_fact.mjs
  hotelFactId: process.env.TL_HOTEL_FACT_ID || 'T8sUNWHQXxaztw7f',
}
const sb = { supabaseApi: CFG.supabase }
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

const input = `// Вхід з вебхука (апка) або з Execute Workflow (голос через бот)
const j = $json.body && typeof $json.body === 'object' ? $json.body : $json;
return [{ json: {
  content_plan_id: String(j.content_plan_id || ''),
  expected_version_no: j.expected_version_no == null ? null : Number(j.expected_version_no),
  author_tg_id: j.author_tg_id ? String(j.author_tg_id) : '',
  via: j.via === 'voice_bot' ? 'voice_bot' : 'text',
  prev_status: ['needs_data', 'ready_for_review', 'changes_requested'].includes(j.prev_status) ? j.prev_status : 'needs_data'
} }];`

// ───── Збирає: що писати в досьє, вхід генератора (як Buffer Filler pre-gate, але з відповідями Іри) ─────
const build = `const inp = $('Code - Input').first().json;
const all = (n) => { try { return $(n).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const s = {};
for (const r of all('Supabase - Get Settings')) s[r.key] = r.value;
const plan = all('Supabase - Get Plan')[0] || null;
const fail = (why) => [{ json: { _ok: false, _error: why, _plan: plan, _inp: inp, supabase_url: String(s.supabase_url || '').replace(/\\/$/, ''), admin_chat_id: String(s.admin_chat_id || '') } }];
if (!plan) return fail('пост не знайдено: ' + inp.content_plan_id);
if (plan.review_status !== 'regenerating') return [{ json: { _ok: false, _quiet: true, _error: 'пост не в роботі (' + plan.review_status + ')', _plan: plan, _inp: inp } }];

const versions = all('Supabase - Get Versions').sort((a, b) => a.version_no - b.version_no);
const cur = versions.find(v => v.id === plan.current_version_id) || null;
const mine = all('Supabase - Get Answers').filter(r => r.answer && (r.content_plan_id === plan.id || (plan.hotel_id && r.hotel_id === plan.hotel_id) || (plan.tour_id && r.tour_id === plan.tour_id)))
  .sort((a, b) => String(a.answered_at || a.created_at).localeCompare(String(b.answered_at || b.created_at)));
if (!mine.length) return fail('нема відповідей Іри для поста');

const hotels = Object.fromEntries(all('Supabase - Get Hotels').map(h => [h.hotel_id, h]));
const tours = Object.fromEntries(all('Supabase - Get Tours').map(t => [t.tour_id, t]));
const story = plan.story_id ? all('Supabase - Get Stories').find(x => x.id === plan.story_id) || null : null;
const hotel = plan.hotel_id && hotels[plan.hotel_id] ? { ...hotels[plan.hotel_id] } : null;
const tour = plan.tour_id && tours[plan.tour_id] ? { ...tours[plan.tour_id] } : null;

const HOTEL_FIELDS = ['key_detail', 'who_for', 'who_not_for', 'caveat', 'ira_notes', 'price_from_night', 'price_from'];
const TOUR_FIELDS = ['price_range', 'dates_example', 'highlights'];
const facts = [], tourPatch = {};
let topic = null, dates = null, subject = null;
const extra = [];
for (const r of mine) {
  const a = String(r.answer).trim();
  if (r.hotel_id && HOTEL_FIELDS.includes(r.field)) {
    facts.push({ hotel_id: r.hotel_id, text: a, field_hint: r.field, mode: r.field.startsWith('price') ? 'replace' : 'append', source: inp.via, question: r.question });
    // у вхід генератора — одразу (досьє оновиться паралельно)
    if (hotel && r.hotel_id === hotel.hotel_id) {
      if (r.field === 'price_from_night' || r.field === 'price_from') hotel._price_text = a;
      else hotel[r.field] = hotel[r.field] && !String(hotel[r.field]).toLowerCase().includes(a.toLowerCase()) ? hotel[r.field] + '; ' + a : (hotel[r.field] || a);
    }
  } else if (r.tour_id && TOUR_FIELDS.includes(r.field)) {
    tourPatch[r.tour_id] = { ...(tourPatch[r.tour_id] || {}), [r.field]: a };
    if (tour && r.tour_id === tour.tour_id) tour[r.field] = a;
  } else if (r.field === 'topic') topic = a;
  else if (r.field === 'dates') dates = a;
  else if (r.field === 'offer_subject') subject = a;
  else extra.push((r.question ? r.question + ' — ' : '') + a);
}

const isOffer = plan.slot_type === 'offer' || String(plan.pillar || '').includes('tour_offer');
const priceText = hotel && (hotel._price_text || (hotel.price_from_night ? 'від ' + hotel.price_from_night + ' ' + (hotel.price_currency || 'USD') + ' за ніч' : String(hotel.price_from || '')));
if (hotel) delete hotel._price_text;
let genTour = tour;
if (tour && !tour.price_range && priceText) genTour = { ...tour, price_range: priceText };
if (isOffer && hotel && !tour) genTour = {
  title: hotel.name, destination: [hotel.country, hotel.region].filter(Boolean).join(', '), segment: (hotel.tags || []).includes('family') ? 'family' : '',
  dates_example: dates || '', price_range: priceText || '', highlights: ''
};

const goldenPlans = Object.fromEntries(all('Supabase - Get Golden Plans').map(p => [p.id, p]));
const golden = all('Supabase - Get Golden Versions').filter(v => v.text && v.content_plan_id !== plan.id && (goldenPlans[v.content_plan_id] || {}).platform === plan.platform)
  .sort((a, b) => String(b.golden_at).localeCompare(String(a.golden_at))).slice(0, 3).map(v => ({ text: v.text }));
const CUTOVER = new Date('2026-09-19T12:00:00Z');
const legacy = all('Supabase - Get Approved Posts').filter(p => p.content && p.created_at && new Date(p.created_at) >= CUTOVER);
const rules = all('Supabase - Get Rules').filter(r => r.scope === 'global' || (r.scope === 'platform' && r.scope_value === plan.platform) || (r.scope === 'pillar' && r.scope_value === plan.pillar) || (r.scope === 'hotel' && r.scope_value === plan.hotel_id)).map(r => r.rule_text);

const qa = mine.map(r => '— ' + (r.question || r.field) + ': ' + String(r.answer).trim()).join('\\n');
const note = [topic && 'Тема від Іри: ' + topic, subject && 'Що пропонуємо (від Іри): ' + subject, dates && 'Дати (від Іри): ' + dates, ...extra].filter(Boolean).join('\\n') || (plan.note || '');
const hasText = !!(cur && cur.text);
const zone = 'Europe/Kyiv';
const dt = plan.scheduled_for ? DateTime.fromISO(plan.scheduled_for, { zone }) : DateTime.now().setZone(zone);
const photoCount = (['video', 'template'].includes(plan.pillar) || ['reel', 'stories'].includes(plan.slot_type)) ? 0 : (plan.platform === 'instagram' && String(plan.slot_type || '').includes('carousel')) ? 3 : 1;

return [{ json: {
  _ok: true,
  _plan: plan, _inp: inp, _cur: cur,
  supabase_url: String(s.supabase_url || '').replace(/\\/$/, ''),
  admin_chat_id: String(s.admin_chat_id || ''),
  mini_app_url: String(s.mini_app_url || '').replace(/\\/$/, ''),
  _req_ids: mine.map(r => r.id),
  _facts: facts,
  _tour_patches: Object.entries(tourPatch).map(([tour_id, patch]) => ({ tour_id, patch })),
  _qa: qa,
  _photo_count: (cur && (cur.media_ids || []).length) || !plan.hotel_id ? 0 : photoCount,
  _gen: {
    mode: hasText ? 'regenerate' : 'initial',
    slot: { day: plan.day, platform: plan.platform, slot_type: plan.slot_type, pillar: plan.pillar, note },
    week_parity: dt.weekNumber % 2 === 0 ? 'even' : 'odd',
    tour: genTour, hotel, story,
    fewshot: [...golden, ...legacy],
    rules,
    old_text: hasText ? cur.text : '',
    ira_feedback: hasText ? 'Іра відповіла на питання агента — врахуй ці факти в пості:\\n' + qa : '',
    had_feedback: hasText,
    passthrough: { content_plan_id: plan.id }
  }
} }];`

const factItems = `// По одному факту на виклик sub-WF; нема фактів про готель → один порожній (sub-WF його пропустить)
const b = $('Code - Build').first().json;
return (b._facts || []).length ? b._facts.map(f => ({ json: f })) : [{ json: { _none: true } }];`

const tourItems = `const b = $('Code - Build').first().json;
return (b._tour_patches || []).length ? b._tour_patches.map(t => ({ json: { ...t, supabase_url: b.supabase_url } })) : [{ json: { _none: true, tour_id: 'none', patch: {}, supabase_url: b.supabase_url } }];`

const genInput = `return [{ json: $('Code - Build').first().json._gen }];`

const parseGen = `// Відповідь генератора → RPC tl_add_version
const g = $json || {};
const b = $('Code - Build').first().json;
const ok = !!(g.status && g.status !== 'failed' && g.text);
const lintErr = g.lint_errors || [];
return [{ json: {
  _ok: ok,
  _error: ok ? '' : String(g.error || g.status || 'генератор не повернув текст').slice(0, 300),
  rpc: ok ? {
    p_content_plan_id: b._plan.id,
    p_text: g.text,
    p_trigger: 'data_answer',
    p_expected_version_no: Number(b._plan.version_no || 0),
    p_hooks: Array.isArray(g.hooks) && g.hooks.length ? g.hooks : null,
    p_form: g.form || null,
    p_key_idea: g.key_idea || null,
    p_model: 'gpt-4.1',
    p_prompt_version: 'PRMPT-011 v4 · data_answer',
    p_lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    p_missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : [],
    p_review_status: 'ready_for_review'
  } : null
} }];`

const versionBody = `={{ JSON.stringify((() => {
  const r = { ...$('Code - Parse Generation').first().json.rpc };
  const pick = $('HTTP - Pick Photos').first().json;
  const ids = pick && pick.statusCode >= 200 && pick.statusCode < 300 && Array.isArray(pick.body) ? pick.body : [];
  if (ids.length) r.p_media_ids = ids;
  return r;
})()) }}`

const message = `// «Нова версія готова» — тому, хто відповідав (Іра або Влад на тесті)
const b = $('Code - Build').first().json;
const plan = b._plan;
const hotel = (($('Code - Build').first().json._gen || {}).hotel) || null;
const tour = (($('Code - Build').first().json._gen || {}).tour) || null;
const plat = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }[plan.platform] || plan.platform;
const title = (hotel && hotel.name) || (tour && tour.title) || plan.pillar;
const url = b.mini_app_url ? b.mini_app_url + '/?startapp=post_' + plan.id : '';
return [{ json: {
  chat_id: String(b._inp.author_tg_id || b.admin_chat_id || ''),
  text: '✨ Нова версія готова\\n' + title + ' · ' + plat + '\\n\\nДописав пост з твоїми відповідями. Глянеш?',
  url
} }];`

const failMsg = `// Не вийшло: пост назад (відповіді лишаються — їх візьме Buffer Filler), Владу коротко
let b = null, why = '';
try { b = $('Code - Build').first().json; } catch (e) { b = null; }
try { const p = $('Code - Parse Generation').first().json; if (p && !p._ok) why = p._error; } catch (e) {}
try { const v = $('HTTP - Add Version').first().json; if (!why && v && v.statusCode >= 300) why = 'tl_add_version HTTP ' + v.statusCode + ': ' + JSON.stringify(v.body || '').slice(0, 200); } catch (e) {}
const plan = (b && b._plan) || {};
const inp = (b && b._inp) || $('Code - Input').first().json;
return [{ json: {
  supabase_url: (b && b.supabase_url) || '',
  plan_id: plan.id || inp.content_plan_id,
  prev_status: inp.prev_status || 'needs_data',
  admin_chat_id: (b && b.admin_chat_id) || '',
  quiet: !!(b && b._quiet),
  note: ('Data Answer: ' + (why || (b && b._error) || 'не вдалось')).slice(0, 300),
  text: '⚠️ Data Answer: не вдалось дописати пост ' + (plan.id || inp.content_plan_id) + ' (' + (inp.via === 'voice_bot' ? 'голос' : 'апка') + '): ' + (why || (b && b._error) || 'невідома помилка') + '\\nВідповіді Іри збережено, пост повернуто в «бракує даних».'
} }];`

const Y = 300
const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, { httpMethod: 'POST', path: 'travellab-data-answer', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {} },
    { webhookId: '3d9a7c41-5e2b-4f8a-b1c6-tl-data-answer', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, 0, { inputSource: 'passthrough' }, { y: 200 }),
  node('Code - Input', 'n8n-nodes-base.code', 2, 220, { jsCode: input }),
  getAll('Supabase - Get Settings', 440, 'settings'),
  getAll('Supabase - Get Plan', 660, 'content_plan', "=id=eq.{{ $('Code - Input').first().json.content_plan_id || '00000000-0000-0000-0000-000000000000' }}"),
  getAll('Supabase - Get Versions', 880, 'post_versions', "=content_plan_id=eq.{{ $('Code - Input').first().json.content_plan_id || '00000000-0000-0000-0000-000000000000' }}"),
  getAll('Supabase - Get Answers', 1100, 'data_requests', 'status=eq.answered'),
  getAll('Supabase - Get Hotels', 1320, 'hotels'),
  getAll('Supabase - Get Tours', 1540, 'tours'),
  getAll('Supabase - Get Stories', 1760, 'story_queue', null, { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Approved Posts', 1980, 'posts', null, { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Golden Versions', 2200, 'post_versions', 'is_golden=eq.true', { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Golden Plans', 2420, 'content_plan',
    "=id=in.({{ $('Supabase - Get Golden Versions').all().map(i => i.json.content_plan_id).filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000' }})",
    { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Rules', 2640, 'ira_rules', 'status=eq.active', { onError: 'continueRegularOutput' }),
  node('Code - Build', 'n8n-nodes-base.code', 2, 2860, { jsCode: build }, { executeOnce: true }),
  ifNode('IF - Ready?', 3080, '={{ $json._ok }}'),
  // досьє: готель через sub-WF, тур — напряму
  node('Code - Hotel Facts', 'n8n-nodes-base.code', 2, 3300, { jsCode: factItems }, { executeOnce: true, y: -Y }),
  node('Execute - Hotel Fact Write', 'n8n-nodes-base.executeWorkflow', 1.2, 3520, {
    source: 'database', workflowId: { __rl: true, value: CFG.hotelFactId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput', y: -Y }),
  node('Code - Tour Patches', 'n8n-nodes-base.code', 2, 3740, { jsCode: tourItems }, { executeOnce: true, y: -Y }),
  rest('HTTP - Patch Tour', 3960, 'PATCH', "={{ $json.supabase_url }}/rest/v1/tours?tour_id=eq.{{ encodeURIComponent($json.tour_id) }}",
    "={{ JSON.stringify(Object.keys($json.patch || {}).length ? { ...$json.patch, updated_at: $now.toISO() } : { tour_id: 'none' }) }}", { y: -Y }),
  node('Code - Generator Input', 'n8n-nodes-base.code', 2, 4180, { jsCode: genInput }, { executeOnce: true }),
  node('Execute - Post Generator', 'n8n-nodes-base.executeWorkflow', 1.2, 4400, {
    source: 'database', workflowId: { __rl: true, value: CFG.generatorId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput' }),
  node('Code - Parse Generation', 'n8n-nodes-base.code', 2, 4620, { jsCode: parseGen }, { executeOnce: true }),
  ifNode('IF - Generated?', 4840, '={{ $json._ok }}'),
  rest('HTTP - Pick Photos', 5060, 'POST', "={{ $('Code - Build').first().json.supabase_url }}/rest/v1/rpc/tl_pick_media",
    "={{ JSON.stringify({ p_plan_id: $('Code - Build').first().json._plan.id, p_count: $('Code - Build').first().json._photo_count || 0 }) }}", { prefer: 'return=representation' }),
  rest('HTTP - Add Version', 5280, 'POST', "={{ $('Code - Build').first().json.supabase_url }}/rest/v1/rpc/tl_add_version", versionBody, { prefer: 'return=representation' }),
  ifNode('IF - Version Added?', 5500, '={{ $json.statusCode >= 200 && $json.statusCode < 300 }}'),
  rest('HTTP - Mark Applied', 5720, 'PATCH',
    "={{ $('Code - Build').first().json.supabase_url }}/rest/v1/data_requests?status=eq.answered&id=in.({{ $('Code - Build').first().json._req_ids.join(',') || '00000000-0000-0000-0000-000000000000' }})",
    "={{ JSON.stringify({ status: 'applied' }) }}"),
  node('Code - Message', 'n8n-nodes-base.code', 2, 5940, { jsCode: message }, { executeOnce: true }),
  node('Telegram - New Version', 'n8n-nodes-base.telegram', 1.2, 6160, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Подивитись', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false },
  }, { credentials: { telegramApi: CFG.telegram }, onError: 'continueRegularOutput' }),
  // збій
  node('Code - Fail', 'n8n-nodes-base.code', 2, 5060, { jsCode: failMsg }, { executeOnce: true, y: Y }),
  ifNode('IF - Report?', 5280, '={{ !$json.quiet }}', { y: Y }),
  rest('HTTP - Revert Plan', 5500, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $json.plan_id }}&review_status=eq.regenerating",
    "={{ JSON.stringify({ review_status: $json.prev_status, review_note: $json.note, updated_at: $now.toISO() }) }}", { y: Y }),
  node('Telegram - Fail To Admin', 'n8n-nodes-base.telegram', 1.2, 5720, {
    chatId: "={{ $('Code - Fail').first().json.admin_chat_id }}", text: "={{ $('Code - Fail').first().json.text }}", additionalFields: { appendAttribution: false },
  }, { credentials: { telegramApi: CFG.telegram }, onError: 'continueRegularOutput', y: Y }),
]

const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const branches = (t, f) => ({ main: [[{ node: t, type: 'main', index: 0 }], [{ node: f, type: 'main', index: 0 }]] })
const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, to(names[i + 1])]))
const connections = {
  Webhook: to('Code - Input'),
  'Execute Workflow Trigger': to('Code - Input'),
  ...chain('Code - Input', 'Supabase - Get Settings', 'Supabase - Get Plan', 'Supabase - Get Versions', 'Supabase - Get Answers', 'Supabase - Get Hotels',
    'Supabase - Get Tours', 'Supabase - Get Stories', 'Supabase - Get Approved Posts', 'Supabase - Get Golden Versions', 'Supabase - Get Golden Plans',
    'Supabase - Get Rules', 'Code - Build', 'IF - Ready?'),
  'IF - Ready?': branches('Code - Hotel Facts', 'Code - Fail'),
  ...chain('Code - Hotel Facts', 'Execute - Hotel Fact Write', 'Code - Tour Patches', 'HTTP - Patch Tour', 'Code - Generator Input', 'Execute - Post Generator', 'Code - Parse Generation', 'IF - Generated?'),
  'IF - Generated?': branches('HTTP - Pick Photos', 'Code - Fail'),
  ...chain('HTTP - Pick Photos', 'HTTP - Add Version', 'IF - Version Added?'),
  'IF - Version Added?': branches('HTTP - Mark Applied', 'Code - Fail'),
  ...chain('HTTP - Mark Applied', 'Code - Message', 'Telegram - New Version'),
  'Code - Fail': to('IF - Report?'),
  'IF - Report?': { main: [[{ node: 'HTTP - Revert Plan', type: 'main', index: 0 }]] },
  'HTTP - Revert Plan': to('Telegram - Fail To Admin'),
}
// HTTP - Patch Tour виконується на кожен тур; далі — один раз
nodes.find((n) => n.name === 'HTTP - Patch Tour').executeOnce = false

const wf = { name: '[TravelLab] Data Answer (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'data_answer.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', nodes.length, 'nodes → n8n/data_answer.json')
else {
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

// node n8n/build_learn_edits.mjs [dump|create|update <id>]   (TL_TEST=1 → тимчасова копія: інший шлях вебхука, без розкладу)
// «[TravelLab] Learn From Edits»: навчання на правках Іри (фаза 7, план §2 #9, §5).
// Щогодини (:20) бере правки до тексту, які ще не розібрано (review_comments.kind is null, старші 15 хв — щоб WF-046 встиг
// їх застосувати), і власні правки тексту Іри в апці (post_versions prompt_version='ira_edit', learned_at is null — SQL 014;
// без колонки цей шматок тихо пропускається). gpt-4.1 класифікує кожну: one_off | style_rule | fact_correction
// + правила (scope hotel | platform | pillar | global, коротке rule_text) + факти.
//   • правила → ira_rules: hotel/platform/pillar — active одразу; global — pending до ✅ Влада (апка, блок «Правила з правок»;
//     нагадування — «[TravelLab] Rules Digest (admin)» щопонеділка);
//   • факти про готель → sub-WF «[TravelLab] Hotel Fact Write (sub)» (mode append, досьє лише зростає);
//   • review_comments.kind + parsed.learn, post_versions.learned_at.
// Окремий WF (а не гілка в WF-046): правка Іри не чекає класифікатора, збій тут не зачіпає «✨ Нова версія готова»,
// а WF-046 лише читає готові правила. Нікому нічого не шле.
// Ручний запуск: POST вебхук travellab-learn-edits (X-TL-Secret) {"dry_run": true, "comment_ids": [...], "limit": 10, "include_edits": false}
//   dry_run — лише класифікація (результат у виконанні, вузол «Code - Decide»), нічого не пише.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  // [TravelLab] Hotel Fact Write (sub) — n8n/build_hotel_fact.mjs
  hotelFactId: process.env.TL_HOTEL_FACT_ID || 'T8sUNWHQXxaztw7f',
  test: process.env.TL_TEST === '1',
}
const sb = { supabaseApi: CFG.supabase }
const node = (name, type, typeVersion, x, parameters, extra = {}) => {
  const { y = 0, ...rest } = extra
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, y], parameters, ...rest }
}
const getAll = (name, x, table, filterString, extra = {}) => node(name, 'n8n-nodes-base.supabase', 1, x, {
  operation: 'getAll', tableId: table, returnAll: true, ...(filterString ? { filterType: 'string', filterString } : {}),
}, { credentials: sb, alwaysOutputData: true, executeOnce: true, ...extra })
const rest = (name, x, method, url, body, extra = {}) => {
  const { prefer = 'return=minimal', ...rest2 } = extra
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, x, {
    method, url,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Prefer', value: prefer }] },
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
    options: { response: { response: { fullResponse: true, neverError: true } } },
  }, { credentials: sb, onError: 'continueRegularOutput', alwaysOutputData: true, ...rest2 })
}
const ifNode = (name, x, leftValue, extra = {}) => node(name, 'n8n-nodes-base.if', 2.2, x, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), leftValue, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
  options: {},
}, extra)

const params = `// Параметри запуску (розклад або ручний вебхук) + URL запитів
let body = {};
try { body = $('Webhook').first().json.body || {}; } catch (e) { body = {}; }
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const base = String(s.supabase_url || '').replace(/\\/$/, '') + '/rest/v1';
const UUID = /^[0-9a-f-]{36}$/i;
const ids = Array.isArray(body.comment_ids) ? body.comment_ids.filter(x => UUID.test(String(x))) : [];
const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 40);
const cutoff = new Date(Date.now() - 15 * 60e3).toISOString();
const commentsUrl = base + '/review_comments?select=*&target=eq.text&kind=is.null&order=created_at.asc&limit=' + limit
  + (ids.length ? '&id=in.(' + ids.join(',') + ')' : '&created_at=lt.' + encodeURIComponent(cutoff));
const withEdits = body.include_edits !== false && !ids.length;
const editsUrl = base + '/post_versions?select=id,content_plan_id,version_no,text&prompt_version=eq.ira_edit&learned_at=is.null&order=created_at.asc&limit=10'
  + (withEdits ? '' : '&id=eq.00000000-0000-0000-0000-000000000000');
return [{ json: { base, dry_run: body.dry_run === true, commentsUrl, editsUrl } }];`

const rows = (name) => `(() => { try { const j = $('${name}').first().json; return j && j.statusCode >= 200 && j.statusCode < 300 && Array.isArray(j.body) ? j.body : []; } catch (e) { return []; } })()`

const planIds = `{{ (() => {
  const c = ${rows('HTTP - Get Comments')};
  const e = ${rows('HTTP - Get Edits')};
  const ids = [...new Set([...c, ...e].map(x => x.content_plan_id).filter(Boolean))];
  return ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000';
})() }}`

export const SYSTEM = [
  'Ти аналізуєш правку Ірини (TravelLab, вона пише пости про luxury-готелі для сімей і пар) до тексту поста і вирішуєш, чого з неї варто навчитись агенту-копірайтеру на майбутнє.',
  'Типи правки (kind):',
  '- one_off — стосується лише цього тексту: «постав мій текст», «прибери дужки», «заміни останню фразу на …», «прибери одне посилання», «коротше» / «тепліше» без ознак, що так треба завжди; конкретні перестановки й заміни. Більшість правок — one_off. НЕ роби правило з разової правки.',
  '- style_rule — з правки видно стійку вимогу до того, ЯК писати, яка повториться в інших постах: тон, лексика, що не згадувати, як подавати мінуси, як починати пост, формат кінцівки на платформі. Ознаки: «завжди / ніколи / не пиши так», пояснення-принцип («бо я розповідаю експертну історію, а не даю довідку»), або вимога явно не лише про цей текст.',
  '- fact_correction — Іра дає або виправляє ФАКТ про готель (що там є, кому підходить, нюанс, її особистий досвід: «я була», «мені запам\'ятався…»). Факти — у facts.',
  'Одна правка може дати і правило, і факт.',
  'Будь стриманою: правило — лише коли вимога очевидно повториться в інших постах; не більше 2 правил з однієї правки. «Тепліше», «коротше», «більше мене», «природніше» без пояснення-принципу — one_off. Якщо Іра просто дала свій готовий текст / фразу для вставки — це one_off (+ факти з нього), правил з її тексту не виводь.',
  'Конкретні відомості про готель (що де є, відстані, кому підходить, нюанси) — це facts, а не rules.',
  'Правило НІКОЛИ не може вимагати: особистого досвіду, вражень чи «я була там» (досвід Іри — лише з її фактів у досьє, агент його не вигадує); порівняльних заяв («рідкісний», «унікальний», «один з небагатьох», «найкращий»); категоричних вироків клієнту; хештегів. Якщо правка до такого підштовхує — сформулюй безпечну суть (наприклад, «подавай як сильну сторону для міжсезоння» замість «як рідкісний») або не створюй правила.',
  'rules[]: rule_text — ОДНЕ коротке речення-інструкція українською (до 160 символів), самодостатнє (зрозуміле без цього поста; для scope hotel — з назвою готелю), без цитування всього поста, без вигадок понад те, що вона сказала.',
  'scope: hotel — як писати саме про цей готель (що підкреслювати, що не подавати як мінус); platform — формат цієї платформи (довжина, посилання, стрілки, емодзі, кінцівка з контактом); pillar — про цю рубрику; global — загальний тон і стиль для всіх постів. Сумніваєшся між вужчим і global — бери вужчий. Готелю нема — scope hotel не став.',
  'Не створюй правило, яке суперечить її базовим заборонам (хештеги, вигаданий особистий досвід) або дублює наявне зі списку «Вже є правила» — тоді постав duplicate_of = id наявного.',
  'facts[] — лише НОВЕ, чого ще нема в блоці «Вже в досьє готелю» (не повторюй наявне іншими словами); не більше 3; одне поле — один факт (кілька деталей одного поля обʼєднуй через «; »). Дати бронювання, ціни, сезони продажу, контакти, побажання до тексту — НЕ факти про готель.',
  'facts[] (лише якщо пост про готель): field — key_detail (що в готелі є / чим він відрізняється: басейни, клуби, сервіс, вілли), who_for (кому підходить), who_not_for (кому варто порівняти інший формат), caveat (лише обмеження чи нюанс, про який варто знати заздалегідь), ira_notes (її особистий досвід / враження / інше); text — факт її словами, коротко, без вигадок і без оцінок від себе.',
  'kind: style_rule — якщо є хоч одне нове правило (не дубль); інакше fact_correction — якщо є факти; інакше one_off.',
  'Відповідь — СТРОГО JSON без іншого тексту: {"kind": "one_off|style_rule|fact_correction", "rules": [{"scope": "hotel|platform|pillar|global", "rule_text": "…", "duplicate_of": null}], "facts": [{"field": "…", "text": "…"}], "why": "коротко українською, чому так"}',
].join('\n')

const buildPrompts = `// Одна правка (коментар до тексту або власна правка тексту Іри) = один запит до класифікатора
const comments = ${rows('HTTP - Get Comments')};
const edits = ${rows('HTTP - Get Edits')};
const versions = ${rows('HTTP - Get Versions')};
const plans = Object.fromEntries(${rows('HTTP - Get Plans')}.map(p => [p.id, p]));
const hotels = Object.fromEntries($('Supabase - Get Hotels').all().map(i => i.json).filter(h => h && h.hotel_id).map(h => [h.hotel_id, h]));
const rules = $('Supabase - Get Rules').all().map(i => i.json).filter(r => r && r.id && r.status !== 'rejected');
const PILLAR = { hotel_place: 'про готель', insider: 'інсайдер', tour_offer: 'офер туру', personal_take: 'думка', family: 'сімейний', unusual_hotels: 'незвичайні готелі', video: 'відео', template: 'шаблон' };
const PLAT = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' };
const cut = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const SYSTEM = ${JSON.stringify(SYSTEM)};

function ctx(plan) {
  const h = plan && plan.hotel_id ? hotels[plan.hotel_id] : null;
  const mine = rules.filter(r => r.scope === 'global' || (plan && ((r.scope === 'platform' && r.scope_value === plan.platform) || (r.scope === 'pillar' && r.scope_value === plan.pillar) || (r.scope === 'hotel' && r.scope_value === plan.hotel_id))))
    .slice(0, 40).map(r => r.id + ' [' + r.scope + (r.scope_value ? ':' + r.scope_value : '') + (r.status === 'pending' ? ', чекає' : '') + '] ' + r.rule_text);
  const dossier = h ? ['key_detail', 'who_for', 'who_not_for', 'caveat', 'ira_notes'].filter(k => h[k]).map(k => k + ': ' + cut(h[k], 600)).join('\\n') : '';
  return { h, head: 'Пост: ' + (plan ? (PLAT[plan.platform] || plan.platform) + ' · рубрика ' + (PILLAR[plan.pillar] || plan.pillar) : 'невідомо')
    + ' · готель: ' + (h ? h.name : '—') + '\\n\\nВже є правила:\\n' + (mine.length ? mine.join('\\n') : '—')
    + (h ? '\\n\\nВже в досьє готелю:\\n' + (dossier || '—') : '') };
}

const out = [];
for (const c of comments) {
  const plan = plans[c.content_plan_id] || null;
  const v = versions.find(x => x.id === c.version_id);
  const { h, head } = ctx(plan);
  const user = head + '\\n\\nТЕКСТ, ДО ЯКОГО ПРАВКА:\\n<<<\\n' + cut(v && v.text, 1500) + '\\n>>>\\n\\nПРАВКА ІРИНИ:\\n<<<\\n' + cut(c.body, 1500) + '\\n>>>'
    + ((c.chips || []).length ? '\\n(швидкі кнопки: ' + c.chips.join(', ') + ')' : '');
  out.push({ json: { unit: 'comment', id: c.id, parsed: c.parsed || null, plan, hotel_id: h ? h.hotel_id : null, body: cut(c.body, 300), chips: c.chips || [], systemPrompt: SYSTEM, userPrompt: user } });
}
for (const e of edits) {
  const plan = plans[e.content_plan_id] || null;
  const prev = versions.filter(x => x.content_plan_id === e.content_plan_id && x.version_no < e.version_no && x.text).sort((a, b) => b.version_no - a.version_no)[0];
  // текст не змінився / нема попередньої версії — позначаємо без розбору (запит-заглушка, щоб пари «правка ↔ відповідь» не з'їхали)
  if (!prev || !e.text || prev.text === e.text) { out.push({ json: { unit: 'edit', id: e.id, plan, skip: true, systemPrompt: 'Відповідай рівно: {}', userPrompt: '{}' } }); continue; }
  const { h, head } = ctx(plan);
  const user = head + '\\n\\nІра САМА переписала текст поста в апці (це і є її правка).\\nБУЛО:\\n<<<\\n' + cut(prev.text, 1500) + '\\n>>>\\n\\nСТАЛО:\\n<<<\\n' + cut(e.text, 1500) + '\\n>>>';
  out.push({ json: { unit: 'edit', id: e.id, plan, hotel_id: h ? h.hotel_id : null, body: 'власна правка тексту', systemPrompt: SYSTEM, userPrompt: user } });
}
return out;`

const decide = `// Відповіді класифікатора → що записати (правила, факти, позначки). Нічого не пише сам
const units = $('Code - Build Prompts').all().map(i => i.json);
const answers = $input.all().map(i => i.json);
const p = $('Code - Params').first().json;
const existing = $('Supabase - Get Rules').all().map(i => i.json).filter(r => r && r.id && r.status !== 'rejected');
const norm = t => String(t || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
const seen = new Set(existing.map(r => r.scope + '|' + (r.scope_value || '') + '|' + norm(r.rule_text)));
const stems = t => new Set(norm(t).split(' ').filter(w => w.length > 3).map(w => w.slice(0, 5)));
const similar = (a, b) => { const A = stems(a), B = stems(b); if (!A.size || !B.size) return false; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size) >= 0.6; };
// факт уже є в досьє (будь-яке поле) або доданий цим прогоном: ≥70% основ його слів там трапляються
const contained = (t, have) => { const A = stems(t), B = stems(have); if (!A.size) return true; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size >= 0.7; };
const hotels = Object.fromEntries($('Supabase - Get Hotels').all().map(i => i.json).filter(h => h && h.hotel_id).map(h => [h.hotel_id, h]));
const factsSeen = {};
const SCOPES = ['hotel', 'platform', 'pillar', 'global'];
const FIELDS = ['key_detail', 'who_for', 'who_not_for', 'caveat', 'ira_notes'];
const parse = (j) => {
  try {
    const m = Array.isArray(j.output) ? j.output[0] : j;
    const b = m && Array.isArray(m.content) ? m.content[0] : null;
    const raw = String((b && b.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
    return JSON.parse(raw);
  } catch (e) { return null; }
};
const ruleRows = [], facts = [], commentPatches = [], learned = [], report = [];
let ai = 0; // відповіді моделі йдуть 1:1 за правками
for (const u of units) {
  const a = answers[ai++] || {};
  if (u.skip) { learned.push(u.id); report.push({ unit: u.unit, id: u.id, kind: 'skip' }); continue; }
  const r = parse(a);
  // лише швидкі кнопки без своїх слів («Тепліше, більше мене») — разова правка, правил не робимо
  const chipOnly = u.unit === 'comment' && (u.chips || []).length && norm(u.body) === norm(u.chips.join(' '));
  if (!r) { report.push({ unit: u.unit, id: u.id, error: 'не розібрано — спробую наступного разу' }); continue; }
  const plan = u.plan || {};
  const newRules = [];
  for (const x of chipOnly ? [] : (Array.isArray(r.rules) ? r.rules : []).slice(0, 2)) {
    let scope = SCOPES.includes(x && x.scope) ? x.scope : null;
    const text = String((x && x.rule_text) || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
    if (!scope || !text || (x.duplicate_of && existing.some(e => e.id === x.duplicate_of))) continue;
    if (scope === 'hotel' && !plan.hotel_id) scope = 'pillar';
    const value = scope === 'global' ? null : scope === 'hotel' ? plan.hotel_id : scope === 'platform' ? plan.platform : plan.pillar;
    if (scope !== 'global' && !value) continue;
    const key = scope + '|' + (value || '') + '|' + norm(text);
    // дубль за змістом (той самий scope, ≥60% спільних основ слів) — не пишемо
    if (seen.has(key) || [...seen].some(k => k.startsWith(scope + '|' + (value || '') + '|') && similar(k.split('|')[2], norm(text)))) continue;
    seen.add(key);
    // рішення #9: global — лише після ✅ Влада
    const row = { rule_text: text, scope, scope_value: value, source_comment_id: u.unit === 'comment' ? u.id : null, status: scope === 'global' ? 'pending' : 'active' };
    newRules.push(row); ruleRows.push(row);
  }
  // Факти: лише нове (чого нема в досьє чи вже додано цим прогоном), одне поле — один запис, не більше 3
  const byField = {};
  for (const f of chipOnly ? [] : Array.isArray(r.facts) ? r.facts : []) {
    const text = String((f && f.text) || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
    if (!u.hotel_id || !text) continue;
    const field = FIELDS.includes(f.field) ? f.field : 'ira_notes';
    const h = hotels[u.hotel_id] || {};
    const have = FIELDS.map(k => String(h[k] || '')).join(' ') + ' ' + (factsSeen[u.hotel_id] || '');
    if (contained(text, have)) continue;
    byField[field] = byField[field] ? byField[field] + '; ' + text : text;
    factsSeen[u.hotel_id] = (factsSeen[u.hotel_id] || '') + ' ' + text;
  }
  const myFacts = Object.entries(byField).slice(0, 3).map(([field, text]) => ({ hotel_id: u.hotel_id, text, field_hint: field, mode: 'append', source: 'правка в апці' }));
  facts.push(...myFacts);
  // правило-дубль наявного — теж style_rule (просто нового рядка не пишемо)
  const kind = chipOnly ? 'one_off' : newRules.length || (r.kind === 'style_rule' && Array.isArray(r.rules) && r.rules.length) ? 'style_rule' : myFacts.length ? 'fact_correction' : 'one_off';
  const learn = { kind, model: 'gpt-4.1', at: new Date().toISOString(), why: String(r.why || '').slice(0, 300), rules: newRules.map(x => ({ scope: x.scope, rule_text: x.rule_text, status: x.status })), facts: myFacts.map(f => ({ field: f.field_hint, text: f.text })) };
  if (u.unit === 'comment') commentPatches.push({ id: u.id, patch: { kind, parsed: { ...((u.parsed && typeof u.parsed === 'object') ? u.parsed : {}), learn } } });
  else learned.push(u.id);
  report.push({ unit: u.unit, id: u.id, kind, rules: learn.rules, facts: learn.facts, why: learn.why, model_kind: r.kind });
}
return [{ json: { dry_run: p.dry_run, base: p.base, ruleRows, facts, commentPatches, learned, report } }];`

const factItems = `const d = $('Code - Decide').first().json;
return d.facts.length ? d.facts.map(f => ({ json: f })) : [{ json: { _none: true } }];`

const patchItems = `const d = $('Code - Decide').first().json;
return d.commentPatches.map(c => ({ json: { ...c, base: d.base } }));`

const D = "$('Code - Decide').first().json"
const nodes = [
  ...(CFG.test ? [] : [node('Schedule - Hourly', 'n8n-nodes-base.scheduleTrigger', 1.2, 0, { rule: { interval: [{ field: 'cronExpression', expression: '20 * * * *' }] } })]),
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, {
    httpMethod: 'POST', path: CFG.test ? 'travellab-learn-edits-test' : 'travellab-learn-edits', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {},
  }, { webhookId: CFG.test ? '7d2e4a10-learn-edits-test' : '7d2e4a10-learn-edits', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 220 }),
  getAll('Supabase - Get Settings', 220, 'settings', 'key=eq.supabase_url'),
  node('Code - Params', 'n8n-nodes-base.code', 2, 440, { jsCode: params }),
  rest('HTTP - Get Comments', 660, 'GET', '={{ $json.commentsUrl }}', null),
  rest('HTTP - Get Edits', 880, 'GET', "={{ $('Code - Params').first().json.editsUrl }}", null),
  rest('HTTP - Get Versions', 1100, 'GET', `={{ $('Code - Params').first().json.base }}/post_versions?select=id,content_plan_id,version_no,text&content_plan_id=in.(${planIds})`, null, { executeOnce: true }),
  rest('HTTP - Get Plans', 1320, 'GET', `={{ $('Code - Params').first().json.base }}/content_plan?select=id,platform,pillar,slot_type,hotel_id&id=in.(${planIds})`, null, { executeOnce: true }),
  getAll('Supabase - Get Hotels', 1540, 'hotels'),
  getAll('Supabase - Get Rules', 1760, 'ira_rules', null, { onError: 'continueRegularOutput' }),
  node('Code - Build Prompts', 'n8n-nodes-base.code', 2, 1980, { jsCode: buildPrompts }),
  node('OpenAI - Classify', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2420, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: { temperature: 0.1 },
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput' }),
  node('Code - Decide', 'n8n-nodes-base.code', 2, 2640, { jsCode: decide }),
  ifNode('IF - Write?', 2860, '={{ !$json.dry_run }}'),
  rest('HTTP - Insert Rules', 3080, 'POST', `={{ ${D}.base }}/ira_rules`, `={{ JSON.stringify(${D}.ruleRows) }}`, { executeOnce: true }),
  node('Code - Fact Items', 'n8n-nodes-base.code', 2, 3300, { jsCode: factItems }),
  ifNode('IF - Fact?', 3520, '={{ !$json._none }}'),
  node('Execute - Hotel Fact Write', 'n8n-nodes-base.executeWorkflow', 1.2, 3740, {
    source: 'database', workflowId: { __rl: true, value: CFG.hotelFactId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput' }),
  rest('HTTP - Mark Edits Learned', 3960, 'PATCH',
    `={{ ${D}.base }}/post_versions?id=in.({{ ${D}.learned.join(',') || '00000000-0000-0000-0000-000000000000' }})`,
    '={{ JSON.stringify({ learned_at: $now.toISO() }) }}', { executeOnce: true }),
  node('Code - Comment Patches', 'n8n-nodes-base.code', 2, 4180, { jsCode: patchItems }),
  rest('HTTP - Patch Comment', 4400, 'PATCH', "={{ $json.base }}/review_comments?id=eq.{{ $json.id }}", '={{ JSON.stringify($json.patch) }}'),
]

const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const connections = {
  ...(CFG.test ? {} : { 'Schedule - Hourly': to('Supabase - Get Settings') }),
  Webhook: to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Code - Params'),
  'Code - Params': to('HTTP - Get Comments'),
  'HTTP - Get Comments': to('HTTP - Get Edits'),
  'HTTP - Get Edits': to('HTTP - Get Versions'),
  'HTTP - Get Versions': to('HTTP - Get Plans'),
  'HTTP - Get Plans': to('Supabase - Get Hotels'),
  'Supabase - Get Hotels': to('Supabase - Get Rules'),
  'Supabase - Get Rules': to('Code - Build Prompts'),
  'Code - Build Prompts': to('OpenAI - Classify'),
  'OpenAI - Classify': to('Code - Decide'),
  'Code - Decide': to('IF - Write?'),
  'IF - Write?': { main: [[{ node: 'HTTP - Insert Rules', type: 'main', index: 0 }], []] },
  'HTTP - Insert Rules': to('Code - Fact Items'),
  'Code - Fact Items': to('IF - Fact?'),
  'IF - Fact?': { main: [[{ node: 'Execute - Hotel Fact Write', type: 'main', index: 0 }], [{ node: 'HTTP - Mark Edits Learned', type: 'main', index: 0 }]] },
  'Execute - Hotel Fact Write': to('HTTP - Mark Edits Learned'),
  'HTTP - Mark Edits Learned': to('Code - Comment Patches'),
  'Code - Comment Patches': to('HTTP - Patch Comment'),
}

const wf = {
  name: (CFG.test ? '[TEST] ' : '') + '[TravelLab] Learn From Edits',
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
}
if (!CFG.test) writeFileSync(join(here, 'learn_edits.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', nodes.length, 'nodes → n8n/learn_edits.json')
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

// node n8n/build_hotel_fact.mjs [dump|create|update <id>]
// «[TravelLab] Hotel Fact Write (sub)»: ядро запису в досьє готелю, винесене з WF-044 Hotel Voice Intake
// (Code - Build Dossier Update + Insert Insight), щоб ним користувались і відповіді з апки, і голос через бот.
// Вхід (Execute Workflow, по одному item): { hotel_id, text, field_hint, mode: 'append'|'replace', source, question? }
//   field_hint → колонка hotels: key_detail / who_for / who_not_for / caveat (переліки через «; »), ira_notes (блок),
//   price_from_night (число + валюта, mode replace). Інше — лише в hotel_insights.extra_notes.
//   append: як у WF-044 — досьє тільки зростає (без дублів), replace: значення перезаписується.
// Пише: PATCH hotels (текстові поля) + окремо PATCH ціни (SQL 007; без колонок — тихо пропускає) + новий рядок hotel_insights.
// Нікому нічого не шле. Сам WF-044 поки не перемкнено на цей sub-WF (працює як раніше).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = { supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' } }
const sb = { supabaseApi: CFG.supabase }
const node = (name, type, typeVersion, x, parameters, extra = {}) => {
  const { y = 0, ...rest } = extra
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, y], parameters, ...rest }
}
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

export const buildFact = `// Факт від Іри → оновлення досьє готелю + рядок hotel_insights (логіка злиття — як у WF-044)
const inp = $('Execute Workflow Trigger').first().json || {};
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const h = $('Supabase - Get Hotel').first().json || {};
const last = $('Supabase - Get Last Insight').first().json || {};
const clean = v => (v == null ? '' : String(v)).trim();
const norm = v => clean(v).toLowerCase().replace(/\\s+/g, ' ');
const text = clean(inp.text).slice(0, 2000);
const field = clean(inp.field_hint);
const mode = inp.mode === 'replace' ? 'replace' : 'append';
if (!inp.hotel_id || !h.hotel_id || !text) return [{ json: { _skip: true, reason: !text ? 'порожній текст' : 'готель не знайдено', hotel_id: inp.hotel_id || null } }];

const mergeList = (o0, n0) => {
  const o = clean(o0), n = clean(n0);
  if (!n) return o || null;
  if (!o) return n;
  const on = norm(o), nn = norm(n);
  if (on.includes(nn)) return o;
  const add = n.split(/;\\s*/).map(clean).filter(x => x && !on.includes(norm(x)));
  return add.length ? o + '; ' + add.join('; ') : o;
};
const mergeNotes = (o0, n0) => {
  const o = clean(o0), n = clean(n0);
  if (!n) return o || null;
  if (!o) return n;
  if (norm(o).includes(norm(n))) return o;
  if (norm(n).includes(norm(o))) return n;
  return o + '\\n' + n;
};

const LIST = ['key_detail', 'who_for', 'who_not_for', 'caveat'];
const patch = {};
let price = null;
if (LIST.includes(field)) patch[field] = mode === 'replace' ? text : mergeList(h[field], text);
else if (field === 'ira_notes') patch.ira_notes = mode === 'replace' ? text : mergeNotes(h.ira_notes, text);
else if (field === 'price_from_night' || field === 'price_from') {
  // «від 450 доларів», «1 200 €», «$850» → число + валюта; не вийшло — лише в нотатки інсайту
  const m = text.replace(/(\\d)[\\s\\u00a0](?=\\d{3}\\b)/g, '$1').match(/(\\d+(?:[.,]\\d+)?)/);
  const cur = /€|eur|євро/i.test(text) ? 'EUR' : /£|gbp|фунт/i.test(text) ? 'GBP' : /грн|uah|₴/i.test(text) ? 'UAH' : 'USD';
  if (m) price = { price_from_night: Number(m[1].replace(',', '.')), price_currency: cur, price_source: 'ira', price_updated_at: new Date().toISOString() };
}

const COL = { key_detail: 'differentiator', who_for: 'best_for', who_not_for: 'not_for', caveat: 'honest_con' };
const n = last.insight_id ? parseInt(String(last.insight_id).replace(/\\D/g, ''), 10) : 0;
const insight = {
  insight_id: 'INS-' + String((n || 0) + 1).padStart(3, '0'),
  hotel_id: h.hotel_id,
  status: 'confirmed',
  raw_transcript: (inp.question ? 'Питання агента: ' + clean(inp.question) + '\\n' : '') + 'Відповідь Іри (' + (inp.source || 'app') + '): ' + text,
};
if (COL[field]) insight[COL[field]] = text;
else insight.extra_notes = (field && field !== 'ira_notes' ? field + ': ' : '') + text;

return [{ json: {
  _skip: false,
  supabase_url: String(s.supabase_url || '').replace(/\\/$/, ''),
  hotel_id: h.hotel_id, field, mode,
  patch: Object.keys(patch).length ? { ...patch, updated_at: new Date().toISOString() } : null,
  price, insight
} }];`

const result = `// Що записано (для того, хто кликав)
const b = $('Code - Build Fact').first().json;
if (b._skip) return [{ json: { ok: false, ...b } }];
const st = (name) => { try { const j = $(name).first().json; return j && j.statusCode ? j.statusCode : null; } catch (e) { return null; } };
const ok = (c) => c == null || (c >= 200 && c < 300);
return [{ json: {
  ok: ok(st('HTTP - Patch Hotel')) && ok(st('HTTP - Insert Insight')),
  hotel_id: b.hotel_id, field: b.field, mode: b.mode,
  hotel_status: b.patch ? st('HTTP - Patch Hotel') : 'skip',
  price_status: b.price ? st('HTTP - Patch Price') : 'skip',
  insight_id: b.insight.insight_id, insight_status: st('HTTP - Insert Insight')
} }];`

const ifNode = (name, x, leftValue, extra = {}) => node(name, 'n8n-nodes-base.if', 2.2, x, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), leftValue, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
  options: {},
}, extra)
const getAll = (name, x, table, filterString, extra = {}) => node(name, 'n8n-nodes-base.supabase', 1, x, {
  operation: 'getAll', tableId: table, returnAll: true, ...(filterString ? { filterType: 'string', filterString } : {}),
}, { credentials: sb, alwaysOutputData: true, executeOnce: true, ...extra })

const nodes = [
  node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, 0, { inputSource: 'passthrough' }),
  getAll('Supabase - Get Settings', 220, 'settings', 'key=eq.supabase_url'),
  getAll('Supabase - Get Hotel', 440, 'hotels', "=hotel_id=eq.{{ $('Execute Workflow Trigger').first().json.hotel_id || 'none' }}"),
  node('Supabase - Get Last Insight', 'n8n-nodes-base.supabase', 1, 660, {
    operation: 'getAll', tableId: 'hotel_insights', limit: 1, orderBy: 'insight_id.desc', filterType: 'none',
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, onError: 'continueRegularOutput' }),
  node('Code - Build Fact', 'n8n-nodes-base.code', 2, 880, { jsCode: buildFact }, { executeOnce: true }),
  ifNode('IF - Write?', 1100, '={{ !$json._skip }}'),
  rest('HTTP - Patch Hotel', 1320, 'PATCH', "={{ $json.supabase_url }}/rest/v1/hotels?hotel_id=eq.{{ encodeURIComponent($json.hotel_id) }}",
    "={{ JSON.stringify($('Code - Build Fact').first().json.patch || {}) }}", { executeOnce: true }),
  rest('HTTP - Patch Price', 1540, 'PATCH', "={{ $('Code - Build Fact').first().json.supabase_url }}/rest/v1/hotels?hotel_id=eq.{{ encodeURIComponent($('Code - Build Fact').first().json.price ? $('Code - Build Fact').first().json.hotel_id : 'none') }}",
    "={{ JSON.stringify($('Code - Build Fact').first().json.price || { price_source: 'ira' }) }}", { executeOnce: true }),
  rest('HTTP - Insert Insight', 1760, 'POST', "={{ $('Code - Build Fact').first().json.supabase_url }}/rest/v1/hotel_insights",
    "={{ JSON.stringify($('Code - Build Fact').first().json.insight) }}", { executeOnce: true }),
  node('Code - Result', 'n8n-nodes-base.code', 2, 1980, { jsCode: result }, { executeOnce: true }),
]
// порожній patch: PATCH з {} на hotel_id=none нічого не зачіпає (а не пише весь рядок)
nodes.find((n) => n.name === 'HTTP - Patch Hotel').parameters.url =
  "={{ $json.supabase_url }}/rest/v1/hotels?hotel_id=eq.{{ encodeURIComponent($json.patch ? $json.hotel_id : 'none') }}"

const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const connections = {
  'Execute Workflow Trigger': to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Supabase - Get Hotel'),
  'Supabase - Get Hotel': to('Supabase - Get Last Insight'),
  'Supabase - Get Last Insight': to('Code - Build Fact'),
  'Code - Build Fact': to('IF - Write?'),
  'IF - Write?': { main: [[{ node: 'HTTP - Patch Hotel', type: 'main', index: 0 }], [{ node: 'Code - Result', type: 'main', index: 0 }]] },
  'HTTP - Patch Hotel': to('HTTP - Patch Price'),
  'HTTP - Patch Price': to('HTTP - Insert Insight'),
  'HTTP - Insert Insight': to('Code - Result'),
}

const wf = { name: '[TravelLab] Hotel Fact Write (sub)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'hotel_fact.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', nodes.length, 'nodes → n8n/hotel_fact.json')
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

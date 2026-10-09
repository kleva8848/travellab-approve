// node n8n/build_rules_digest.mjs [dump|create|update <id>]
// «[TravelLab] Rules Digest (admin)»: щопонеділка о 09:00 (Київ) — Владу (settings.admin_chat_id, ТІЛЬКИ він) список правил з правок Іри:
//   • глобальні, що чекають ✅ (рішення #9 плану: global діє лише після схвалення);
//   • що за тиждень увімкнулись самі (готель / платформа / рубрика) — щоб міг вимкнути невдале.
// Схвалення — в апці: кнопка відкриває startapp=rules → блок «Правила з правок» (видно лише ADMIN_TG_IDS) з ✅ / ❌.
// Нічого нового — нічого не шле. Ручний запуск: POST вебхук travellab-rules-digest (X-TL-Secret) {"force": true}.
// Ірі не шле ніколи: chat_id береться лише з admin_chat_id, без нього — тиша.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
}
const sb = { supabaseApi: CFG.supabase }
const node = (name, type, typeVersion, x, parameters, extra = {}) => {
  const { y = 0, ...rest } = extra
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, y], parameters, ...rest }
}

const digest = `// Текст дайджесту Владу (або нічого)
let force = false;
try { force = $('Webhook').first().json.body.force === true; } catch (e) { force = false; }
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const rules = $('Supabase - Get Rules').all().map(i => i.json).filter(r => r && r.id);
const hotels = Object.fromEntries($('Supabase - Get Hotels').all().map(i => i.json).filter(h => h && h.hotel_id).map(h => [h.hotel_id, h.name]));
const PLAT = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' };
const where = r => r.scope === 'hotel' ? (hotels[r.scope_value] || r.scope_value) : r.scope === 'platform' ? (PLAT[r.scope_value] || r.scope_value) : r.scope === 'pillar' ? 'рубрика ' + r.scope_value : 'усі пости';
const weekAgo = Date.now() - 7 * 864e5;
const pending = rules.filter(r => r.status === 'pending').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const fresh = rules.filter(r => r.status === 'active' && r.scope !== 'global' && new Date(r.created_at).getTime() >= weekAgo);
const chat = String(s.admin_chat_id || '');
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
if (!chat || !base || (!pending.length && !fresh.length && !force)) return [{ json: { send: false, pending: pending.length, fresh: fresh.length } }];
const lines = ['🧠 Правила з правок Іри'];
if (pending.length) {
  lines.push('', 'Чекають твого ✅ (діятимуть на всі пости):');
  pending.slice(0, 15).forEach((r, i) => lines.push((i + 1) + '. ' + r.rule_text));
  if (pending.length > 15) lines.push('…і ще ' + (pending.length - 15));
}
if (fresh.length) {
  lines.push('', 'За тиждень увімкнулись самі:');
  fresh.slice(0, 15).forEach(r => lines.push('• ' + where(r) + ': ' + r.rule_text));
  if (fresh.length > 15) lines.push('…і ще ' + (fresh.length - 15));
}
if (!pending.length && !fresh.length) lines.push('', 'Нових правил нема.');
lines.push('', 'Схвалити, відхилити чи вимкнути — в апці, блок «Правила з правок» (бачиш лише ти).');
return [{ json: { send: true, chat_id: chat, text: lines.join('\\n').slice(0, 3900), url: base + '/?startapp=rules' } }];`

const nodes = [
  node('Schedule - Monday 09:00', 'n8n-nodes-base.scheduleTrigger', 1.2, 0, { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1' }] } }),
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, {
    httpMethod: 'POST', path: 'travellab-rules-digest', authentication: 'headerAuth', responseMode: 'lastNode', options: {},
  }, { webhookId: '9c41e7b2-rules-digest', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 220 }),
  node('Supabase - Get Settings', 'n8n-nodes-base.supabase', 1, 220, { operation: 'getAll', tableId: 'settings', returnAll: true }, { credentials: sb, executeOnce: true, alwaysOutputData: true }),
  node('Supabase - Get Rules', 'n8n-nodes-base.supabase', 1, 440, { operation: 'getAll', tableId: 'ira_rules', returnAll: true }, { credentials: sb, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' }),
  node('Supabase - Get Hotels', 'n8n-nodes-base.supabase', 1, 660, { operation: 'getAll', tableId: 'hotels', returnAll: true }, { credentials: sb, executeOnce: true, alwaysOutputData: true }),
  node('Code - Digest', 'n8n-nodes-base.code', 2, 880, { jsCode: digest }),
  node('IF - Send?', 'n8n-nodes-base.if', 2.2, 1100, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'send', leftValue: '={{ $json.send }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }),
  node('Telegram - To Admin', 'n8n-nodes-base.telegram', 1.2, 1320, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Відкрити правила', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false },
  }, { credentials: { telegramApi: CFG.telegram }, onError: 'continueRegularOutput' }),
]
const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const connections = {
  'Schedule - Monday 09:00': to('Supabase - Get Settings'),
  Webhook: to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Supabase - Get Rules'),
  'Supabase - Get Rules': to('Supabase - Get Hotels'),
  'Supabase - Get Hotels': to('Code - Digest'),
  'Code - Digest': to('IF - Send?'),
  'IF - Send?': { main: [[{ node: 'Telegram - To Admin', type: 'main', index: 0 }], []] },
}

const wf = { name: '[TravelLab] Rules Digest (admin)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'rules_digest.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', nodes.length, 'nodes → n8n/rules_digest.json')
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

// node n8n/build_autopublish.mjs [dump|create|update <id>]   (n8n id: jPtPwd5WpUdXuhoE, створено 09.10 неактивним → update jPtPwd5WpUdXuhoE)
// «[TravelLab] Autopublish TG»: кожні 5 хв — якщо settings.autopublish_tg = "on", кличе Vercel POST {mini_app_url}/api/publish
// (X-TL-Secret через credential «TravelLab Approve Webhook» — той самий секрет N8N_WEBHOOK_SECRET). Вся логіка (що пора,
// рендер, відправка в канал, замок, статус published, повідомлення Владу про помилку публікації) — у Vercel server/publish.ts.
// Тут лише розклад + повідомлення Владу, якщо сам ендпоінт недоступний. Створюється НЕАКТИВНИМ (чекає каналу Іри).
// Перевірка без відправки: curl -X POST {mini_app_url}/api/publish -H 'X-TL-Secret: …' -d '{"dry_run":true}'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
}
let x = 0
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [(x += 220), extra.y ?? 0], parameters, ...extra })

const prepare = `// Перемикач вимкнено / не налаштовано → нічого не робимо (жодного виклику Vercel)
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
if (s.autopublish_tg !== 'on') return [];
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
if (!base) throw new Error('settings.mini_app_url порожній');
return [{ json: { url: base + '/api/publish', admin_chat_id: String(s.admin_chat_id || '') } }];`

const nodes = [
  node('Schedule - Every 5 min', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }),
  node('Supabase - Get Settings', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'settings', returnAll: true,
    filterType: 'string', filterString: 'key=in.(autopublish_tg,mini_app_url,admin_chat_id)',
  }, { credentials: { supabaseApi: CFG.supabase }, executeOnce: true }),
  node('Code - Check Switch', 'n8n-nodes-base.code', 2, { jsCode: prepare }, { executeOnce: true }),
  node('HTTP - Publish Due Posts', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.url }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '{}',
    options: { timeout: 70000 },
  }, { credentials: { httpHeaderAuth: CFG.webhookAuth }, onError: 'continueErrorOutput' }),
  node('Telegram - Alert Admin', 'n8n-nodes-base.telegram', 1.2, {
    chatId: "={{ $('Code - Check Switch').first().json.admin_chat_id }}",
    text: "={{ '⚠️ Автопублікація TG: Vercel /api/publish не відповів\\n' + String($json.error?.message || $json.error || 'помилка').slice(0, 500) }}",
    additionalFields: { appendAttribution: false },
  }, { credentials: { telegramApi: CFG.telegram }, onError: 'continueRegularOutput', y: 200 }),
]

const to = (n) => ({ main: [[{ node: n, type: 'main', index: 0 }]] })
const connections = {
  'Schedule - Every 5 min': to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Code - Check Switch'),
  'Code - Check Switch': to('HTTP - Publish Due Posts'),
  'HTTP - Publish Due Posts': { main: [[], [{ node: 'Telegram - Alert Admin', type: 'main', index: 0 }]] },
}
for (const n of nodes) delete n.y
const wf = { name: '[TravelLab] Autopublish TG', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'autopublish.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/autopublish.json')
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

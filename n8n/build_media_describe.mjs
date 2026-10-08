// node n8n/build_media_describe.mjs [dump|create|update <id>]
// «[TravelLab] Media describe (Mini App)»: Іра завантажила своє фото в апці → Vision (той самий промпт, що WF-022 /upload)
// → media.description + tags. Викликає Vercel /api/review (add_photo) після завантаження; апка не чекає.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
}
const sb = { supabaseApi: CFG.supabase }
let x = 0
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [(x += 220), 0], parameters, ...extra })

const PROMPT = "Опиши це фото готелю українською мовою для медіа-бібліотеки luxury travel-агентства: 1-2 атмосферних речення (наприклад: 'захід сонця з приватного пляжу, шезлонги, тиша'). Потім додай 3-6 коротких тегів англійською мовою (наприклад: beach, sunset, private, luxury, pool, room, spa, view). Поверни СТРОГО валідний JSON без жодного додаткового тексту, у форматі: {\"description\": \"...\", \"tags\": [\"...\", \"...\"]}"

const prepare = `const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const m = $('Supabase - Get Media').first().json;
if (!m || !m.storage_path) throw new Error('media без storage_path: ' + $('Webhook').first().json.body.media_id);
return [{ json: { media_id: m.media_id, url: String(s.supabase_url || '').replace(/\\/$/, '') + '/storage/v1/object/post-media/' + m.storage_path } }];`

const parse = `// Той самий розбір, що в WF-022; теги у форматі Postgres-масиву
const id = $('Code - Prepare').first().json.media_id;
let parsed;
try {
  const message = Array.isArray($json) ? $json[0] : $json;
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = ((block && block.text) || '').trim().replace(/^\`\`\`json\\s*|\`\`\`$/g, '');
  parsed = JSON.parse(raw);
} catch (e) { parsed = { description: '', tags: [] }; }
const tags = (Array.isArray(parsed.tags) ? parsed.tags : []).map(t => String(t).replace(/[{}",]/g, '').trim()).filter(Boolean);
return [{ json: { media_id: id, description: parsed.description || '', tags_pg: '{' + tags.join(',') + '}' } }];`

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-media-describe', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {} },
    { webhookId: '3e8b0f52-91c4-4d7a-b6e3-tl-media-describe', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  node('Supabase - Get Media', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'media', returnAll: false, limit: 1,
    filterType: 'manual', matchType: 'allFilters', filters: { conditions: [{ keyName: 'media_id', condition: 'eq', keyValue: '={{ $json.body.media_id }}' }] },
  }, { credentials: sb }),
  node('Supabase - Get Settings', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'settings', returnAll: true }, { credentials: sb, executeOnce: true }),
  node('Code - Prepare', 'n8n-nodes-base.code', 2, { jsCode: prepare }),
  node('HTTP - Download From Storage', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}', authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { credentials: sb }),
  node('OpenAI - Analyze Photo', '@n8n/n8n-nodes-langchain.openAi', 2.3, {
    resource: 'image', operation: 'analyze',
    modelId: { __rl: true, mode: 'list', value: 'gpt-4o-mini', cachedResultName: 'GPT-4O-MINI' },
    inputType: 'base64', binaryPropertyName: 'data', text: PROMPT, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput' }),
  node('Code - Parse Vision', 'n8n-nodes-base.code', 2, { jsCode: parse }),
  node('Supabase - Update Media', 'n8n-nodes-base.supabase', 1, {
    operation: 'update', tableId: 'media', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [{ keyName: 'media_id', condition: 'eq', keyValue: '={{ $json.media_id }}' }] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [
      { fieldId: 'description', fieldValue: '={{ $json.description }}' },
      { fieldId: 'tags', fieldValue: '={{ $json.tags_pg }}' },
    ] },
  }, { credentials: sb }),
]
const names = nodes.map((n) => n.name)
const connections = Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const wf = { name: '[TravelLab] Media describe (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'media_describe.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/media_describe.json')
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

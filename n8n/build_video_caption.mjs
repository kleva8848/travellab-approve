// node n8n/build_video_caption.mjs [dump|create|update <id>]
// «[TravelLab] Video Caption Rewrite (Mini App)» (WF-061): Vercel (server/video.ts rewriteCaption) → новий підпис до рілсу / TG-відео за правкою Іри.
// На вході: поточний підпис, правка + чіпи, текст на екрані, голос, готель / місце, правила Іри (ira_rules active — підбирає Vercel).
// Відео не чіпаємо — лише текст. Синхронно: відповідь — JSON останнього вузла {caption}.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
}
let x = 0
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [(x += 220), 0], parameters, ...extra })

// Тон Іри (PRMPT-011) і правила підпису — ті самі, що montage-test/video_agent.py (SYSTEM + CAPTION_RULES)
const SYSTEM = `Ти — контент-агентка Іри (TravelLab: кураторка люкс-подорожей, острівні family-резорти, Мальдіви).
Переписуєш підпис (caption) — текст ПІД коротким вертикальним відео — за правкою Іри.
Тон Іри (PRMPT-011): жива проста мова, звертання на «ви», ОДНА думка на відео; не вигадуй, що Іра там була
(без «я була», «з власного досвіду», «ми відпочивали»); без перебільшень («найкращий», «єдиний», «мало де», «рай»);
не називай готель, якого нема в даних. Кожне речення — граматично правильна природна українська.

Правила підпису: 80–600 знаків, 2–4 короткі абзаци; перший рядок — гачок; далі 1–2 живі деталі, що видно в кадрах, і що це дає людині;
звертання на «ви»; без хештегів, цін, знижок, CTA, питань-опитувань, «посилання в біо»; емодзі — максимум 2 або жодного;
не повторюй дослівно текст з екрана.

Як працювати з правкою:
- зроби саме те, що просить Іра; її правка важливіша за правила вище (крім вигадок — нічого не вигадуй);
- те, про що вона не просила, лишай як було — не переписуй підпис з нуля без потреби;
- факти — лише з її правки, поточного підпису, тексту на екрані й голосу.

Поверни СТРОГО JSON: {"caption": "новий підпис"}.`

const prepare = `const b = $json.body || {};
const comment = String(b.comment || '').trim();
const chips = Array.isArray(b.chips) ? b.chips.filter(Boolean).slice(0, 10) : [];
if (!comment && !chips.length) throw new Error('потрібна правка');
const rules = Array.isArray(b.rules) ? b.rules.filter(Boolean).slice(0, 12) : [];
const user = [
  (b.format === 'reel' ? 'Рілс' : 'Відео') + ' «' + (b.name || '') + '» · ' + (b.platform === 'telegram' ? 'Telegram-канал' : 'Instagram'),
  'Місце: ' + (b.place || '—') + (b.hotel ? ' · готель ' + b.hotel : ''),
  'Текст на екрані: ' + (b.screen || '—'),
  b.voice ? 'Голос Іри (субтитри): ' + b.voice : '',
  '',
  'Поточний підпис:',
  String(b.caption || '').trim() || '(порожньо — напиши новий)',
  '',
  'ПРАВКА ІРИ: ' + (comment || chips.join(' · ')),  // чіпи апка вже дописує в текст правки
  rules.length ? '\\nПРАВИЛА ІРИ З ЇЇ ПОПЕРЕДНІХ ПРАВОК (дотримуйся; її поточна правка має пріоритет):\\n' + rules.map(r => '— ' + r).join('\\n') : '',
].filter(s => s !== '').join('\\n');
return [{ json: { body: {
  model: 'gpt-4.1',
  temperature: 0.6,
  response_format: { type: 'json_object' },
  messages: [ { role: 'system', content: ${JSON.stringify(SYSTEM)} }, { role: 'user', content: user } ],
} } }];`

const parse = `let o = {};
try { o = JSON.parse($json.choices[0].message.content); } catch (e) { o = {}; }
const caption = String(o.caption || '')
  .replace(/(^|\\s)#[\\w\\u0400-\\u04FF]+/g, '$1')
  .replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2200);
return [{ json: { caption } }];`

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-video-caption', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '3e8b1f62-9a4d-4c71-b2e5-tl-video-caption', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  node('Code - Build Request', 'n8n-nodes-base.code', 2, { jsCode: prepare }),
  node('HTTP - OpenAI Caption', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: { timeout: 45000 },
  }, { credentials: { openAiApi: CFG.openai } }),
  node('Code - Parse Caption', 'n8n-nodes-base.code', 2, { jsCode: parse }),
]
const names = nodes.map((n) => n.name)
const connections = Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const wf = { name: '[TravelLab] Video Caption Rewrite (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'video_caption.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/video_caption.json')
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

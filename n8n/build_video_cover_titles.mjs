// node n8n/build_video_cover_titles.mjs [dump|create|update <id>]
// «[TravelLab] Video Cover Titles (Mini App)»: Vercel (server/video.ts coverTitles, кнопка «✨ Варіанти» в обкладинці) → 3–4 короткі заголовки.
// На вході: назва / формат / місце / готель, поточні надпис і заголовок, текст на екрані, голос, підпис, правила Іри (ira_rules active — підбирає Vercel).
// Нічого не зберігає — Іра тапає варіант у апці. Синхронно: відповідь — JSON останнього вузла {titles: [...]}.
// Так само, як WF-061 (Video Caption Rewrite): той самий секрет вебхука, той самий OpenAI credential — у Vercel нових ключів не треба.
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

// Тон Іри (PRMPT-011) — як SYSTEM у montage-test/video_agent.py і WF-061; правила заголовка — як ai_title у montage-test/cover.py
const SYSTEM = `Ти — контент-агентка Іри (TravelLab: кураторка люкс-подорожей, острівні family-резорти, Мальдіви).
Пишеш ЗАГОЛОВОК ДЛЯ ОБКЛАДИНКИ короткого вертикального відео (рілс / сторіз) — великий напис на першому кадрі, який видно в сітці профілю.
Якщо формат «Фото-пост» — це напис на фото поста (редактор Іри в апці): та сама логіка, деталь бери з підпису до поста й готелю.
Тон Іри (PRMPT-011): жива проста мова, ОДНА думка; не вигадуй, що Іра там була (без «я була», «ми відпочивали»);
без перебільшень («найкращий», «єдиний», «мало де», «рай», «казка»); не називай готель, якого нема в даних. Природна граматично правильна українська.

Правила заголовка:
- 2–6 слів, з великої літери, без крапки в кінці, без лапок, без емодзі, без хештегів, без питань-опитувань і CTA;
- звертання — лише на «ви» або взагалі без звертання; НІКОЛИ «ти», «тобі», «тебе», «тобою», «твій»;
- один смисл: конкретна деталь або дія, яку видно у відео (з тексту на екрані / голосу / підпису) — вода, ранок, вілла, пірс, сніданок;
  без абстракцій і кліше («потік часу», «старт дня», «гармонія», «магія», «атмосфера спокою»);
- у кожному варіанті рівно ОДНЕ ключове слово познач *зірочками* (воно буде золотим) — це іменник або дієслово, не прийменник;
- не повторюй дослівно поточний заголовок і текст з екрана; варіанти мають бути різні між собою (різний кут: місце, відчуття, деталь, дія);
- надпис зверху (kicker) уже є окремо — не дублюй його в заголовку.

Поверни СТРОГО JSON: {"titles": ["…", "…", "…", "…"]} — 4 варіанти.`

const prepare = `const b = $json.body || {};
const rules = Array.isArray(b.rules) ? b.rules.filter(Boolean).slice(0, 12) : [];
const user = [
  (b.format === 'photo' ? 'Фото-пост' : b.format === 'reel' ? 'Рілс' : 'Сторіз') + ' «' + (b.name || '') + '» · ' + (b.platform === 'telegram' ? 'Telegram-канал' : 'Instagram'),
  'Місце: ' + (b.place || '—') + (b.hotel ? ' · готель ' + b.hotel : ''),
  'Надпис зверху (kicker): ' + (b.kicker || '—'),
  'Поточний заголовок: ' + (b.title || '—'),
  'Текст на екрані: ' + (b.screen || '—'),
  b.voice ? 'Голос Іри (субтитри): ' + b.voice : '',
  b.caption ? 'Підпис до поста: ' + b.caption : '',
  rules.length ? '\\nПРАВИЛА ІРИ З ЇЇ ПОПЕРЕДНІХ ПРАВОК (дотримуйся):\\n' + rules.map(r => '— ' + r).join('\\n') : '',
].filter(s => s !== '').join('\\n');
return [{ json: { body: {
  model: 'gpt-4.1',
  temperature: 0.9,
  response_format: { type: 'json_object' },
  messages: [ { role: 'system', content: ${JSON.stringify(SYSTEM)} }, { role: 'user', content: user } ],
} } }];`

// Сира перевірка тут; остаточна (2–7 слів, одне золоте, дублікати) — cleanTitle у server/video.ts
const parse = `let o = {};
try { o = JSON.parse($json.choices[0].message.content); } catch (e) { o = {}; }
const titles = (Array.isArray(o.titles) ? o.titles : [])
  .map(t => String(t || '').replace(/#[\\w\\u0400-\\u04FF]+/g, '').replace(/\\s+/g, ' ').trim())
  .map(t => t.charAt(0).toUpperCase() + t.slice(1))
  .filter(t => t && !/(^|[^а-яґєії])(ти|тобі|тебе|тобою|твій|твоя|твоє|твої)([^а-яґєії]|$)/i.test(t))
  .slice(0, 6);
return [{ json: { titles } }];`

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-video-cover-titles', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '5f0c6a8e-2d47-4b9e-9c13-8a6e2f4b7d21', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  node('Code - Build Request', 'n8n-nodes-base.code', 2, { jsCode: prepare }),
  node('HTTP - OpenAI Titles', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: { timeout: 35000 },
  }, { credentials: { openAiApi: CFG.openai } }),
  node('Code - Parse Titles', 'n8n-nodes-base.code', 2, { jsCode: parse }),
]
const names = nodes.map((n) => n.name)
const connections = Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const wf = { name: '[TravelLab] Video Cover Titles (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'video_cover_titles.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/video_cover_titles.json')
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

// node n8n/build_photo_text.mjs [dump|create|update <id>]
// «[TravelLab] Photo text (Mini App)»: Vercel (render.ts, «Надіслати в чат») → текст на перше фото поста.
// Vision бачить фото (де люди / обличчя) + текст поста → {kicker, title, zone}. Синхронно: відповідь — JSON останнього вузла.
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

// Правила тону — з ToV_Rules_Registry (R-010 без вигаданого, R-017 без хештегів, R-021/R-022 без реклами й «найкращий/рідкісний»)
const SYSTEM = `Ти пишеш короткий текст НА ФОТО для поста Іри Стойко (TravelLab — кураторка сімейного острівного відпочинку, Instagram / Telegram).
Поверни СТРОГО JSON: {"kicker": "...", "title": "...", "zone": "top" | "bottom"}.

title — головний рядок на фото (шрифт Prata):
- українською, з великої літери, 3–8 слів, до 45 знаків, без крапки в кінці;
- найсильніша КОНКРЕТНА деталь з поста (що саме там є / для кого / що відчуєш), а не загальна категорія на кшталт «готелі для дорослих»; зрозуміла без підпису;
- тільки факти з тексту поста — нічого не вигадуй (цифри, ціни, послуги — лише якщо вони є в тексті);
- спокійний тон Іри, як порада подрузі: без реклами, без «найкращий / рідкісний / мало де / унікальний / неймовірний», без знаків оклику, емодзі, хештегів і лапок;
- не повторюй дослівно перше речення посту.

kicker — дрібний рядок над заголовком (шрифт Tenor Sans, капсом): місце або готель, напр. «Мальдіви · Avani+ Fares», «Корфу · Ikos Odisia». До 32 знаків (якщо довше — лише назва готелю). Якщо в базі є готель — kicker обов'язковий. Якщо пост не про конкретне місце — порожній рядок.

zone — де на фото менше деталей і НЕМАЄ людей, облич, дітей: "top" або "bottom". Текст не має лягати на людей.`

const prepare = `const b = $json.body || {};
if (!b.text || !b.image_url) throw new Error('потрібні text і image_url');
const user = 'Платформа: ' + (b.platform || '') + '\\nГотель / місце з бази: ' + (b.hotel || '—') + '\\n\\nТекст поста:\\n' + String(b.text).slice(0, 3000);
return [{ json: { body: {
  model: 'gpt-4.1',
  temperature: 0.5,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: ${JSON.stringify(SYSTEM)} },
    { role: 'user', content: [ { type: 'text', text: user }, { type: 'image_url', image_url: { url: b.image_url, detail: 'low' } } ] },
  ],
} } }];`

const parse = `let o = {};
try { o = JSON.parse($json.choices[0].message.content); } catch (e) { o = {}; }
const clean = (s, n) => String(s || '').replace(/[«»"#!]/g, '').replace(/\\s+/g, ' ').replace(/[.\\s]+$/, '').trim().slice(0, n);
let title = clean(o.title, 70);
title = title.charAt(0).toUpperCase() + title.slice(1);
let kicker = clean(o.kicker, 80);
if (kicker.length > 34 && kicker.includes('·')) kicker = kicker.split('·').pop().trim(); // задовге «Країна · Готель» → лише готель
if (kicker.length > 34) kicker = '';
return [{ json: { title, kicker, zone: o.zone === 'top' || o.zone === 'bottom' ? o.zone : null } }];`

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-photo-text', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '7c41d2e9-5b8a-4f36-9e1d-tl-photo-text', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  node('Code - Build Request', 'n8n-nodes-base.code', 2, { jsCode: prepare }),
  node('HTTP - OpenAI Photo Text', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: { timeout: 25000 },
  }, { credentials: { openAiApi: CFG.openai } }),
  node('Code - Parse Text', 'n8n-nodes-base.code', 2, { jsCode: parse }),
]
const names = nodes.map((n) => n.name)
const connections = Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const wf = { name: '[TravelLab] Photo text (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'photo_text.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/photo_text.json')
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

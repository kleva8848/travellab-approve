// node n8n/build_media_intake.mjs [dump | create | update <voiceId> <mediaId>]
// Сет 1 плану Ira_Knowledge_Intake_Design_2026-11-16: фото й голос про готель переїжджають з test_mergebot у бот Іри.
// Беремо знімки живих WF-022 «Media Intake» і WF-044 «Hotel Voice Intake» (n8n/src/*_2026-11-16.json) і робимо дві копії-підворкфлоу,
// які викликає WF-055 (build_voice_answers.mjs):
//  • «[TravelLab] Media Intake (Ira bot)» — Telegram Trigger → Execute Workflow Trigger (вхід: { message: { chat: { id }, text } },
//    той самий, що Route Message читав з Telegram), тестовий вебхук прибрано (шлях зайнятий оригіналом);
//  • «[TravelLab] Hotel Voice Intake (Ira bot)» — те саме ядро сесій intake_sessions; вхід { branch, chat_id, text, voice_file_id }.
// У обох: Telegram-доступ = бот Іри, без підпису n8n; команди в текстах → кнопки; під відповідями — inline-кнопки
// (📂 папка / ✅ Фото готово, ✅ Це все / 👍 Зберегти / ❌ Скасувати). Кнопки шлють callback у WF-055, він перетворює їх на команди.
// Логіка фото (HEIC → thumbnailLink, executeOnce на List, дедуп) і Drive-папки («Travel lab», «Destinations», «Google Drive Іра») — без змін.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const IRA_TG = { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' }
const load = (f) => JSON.parse(readFileSync(join(here, 'src', f), 'utf8'))

const byName = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name)
  if (!n) throw new Error(`${wf.name}: нема ноди «${name}»`)
  return n
}
const setCode = (wf, name, js) => { byName(wf, name).parameters.jsCode = js }
// заміна тексту з перевіркою: зник рядок у джерелі — збірка падає, а не мовчки лишає стару команду
const swap = (wf, name, field, from, to) => {
  const p = byName(wf, name).parameters
  if (!String(p[field]).includes(from)) throw new Error(`${name}.${field}: не знайдено «${from}»`)
  p[field] = String(p[field]).split(from).join(to)
}
const removeNode = (wf, name) => {
  byName(wf, name)
  wf.nodes = wf.nodes.filter((n) => n.name !== name)
  delete wf.connections[name]
}
const btnCb = (text, cb) => ({ text, additionalFields: { callback_data: cb } })
const btnUrl = (text, url) => ({ text, additionalFields: { url } })
const keyboard = (wf, name, rows) => {
  const p = byName(wf, name).parameters
  p.replyMarkup = 'inlineKeyboard'
  p.inlineKeyboard = { rows: rows.map((buttons) => ({ row: { buttons } })) }
}
// усі Telegram-ноди → бот Іри, без «sent automatically with n8n»
const toIraBot = (wf) => {
  for (const n of wf.nodes) {
    if (n.type !== 'n8n-nodes-base.telegram') continue
    n.credentials = { telegramApi: IRA_TG }
    if (n.parameters.resource !== 'file') n.parameters.additionalFields = { ...(n.parameters.additionalFields || {}), appendAttribution: false }
  }
}
const finish = (wf, name) => ({ name, nodes: wf.nodes, connections: wf.connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' } })

// ───────────────────────── Готовність нового готелю (сет 2, 21.11) ─────────────────────────
// Готель-чернетка (status='needs_review', створений «➕ Новий готель») стає Active + Ready, коли є ≥ 5 фото в media і збережена (confirmed)
// картка hotel_insights. Перевірка — після опису фото (Media Intake) і після збереження картки (Hotel Voice). Інші статуси (Active/Inactive) не чіпаємо.
const MIN_PHOTOS = 5
const SB = { supabaseApi: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' } }
const nid = (s) => 'rdy-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
function addReadiness(wf, afterName, ctxJs) {
  const base = byName(wf, afterName).position
  const at = (i) => [base[0] + 240 * (i + 1), base[1] + 360]
  const get = (name, table, i) => ({ id: nid(name), name, type: 'n8n-nodes-base.supabase', typeVersion: 1, alwaysOutputData: true, position: at(i), credentials: SB,
    parameters: { operation: 'getAll', tableId: table, returnAll: true, filterType: 'manual',
      filters: { conditions: [{ keyName: 'hotel_id', condition: 'eq', keyValue: "={{ $('Code - Readiness Ctx').first().json.hotel_id }}" }] } } })
  const code = (name, js, i) => ({ id: nid(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: at(i), parameters: { jsCode: js } })
  const ifb = (name, left, i) => ({ id: nid(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position: at(i), parameters: {
    conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: nid(name) + '-c', operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: left, rightValue: '' }] }, options: {} } })
  const tg = (name, rows, i) => ({ id: nid(name), name, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: at(i), webhookId: undefined,
    parameters: { resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}',
      ...(rows ? { replyMarkup: 'inlineKeyboard', inlineKeyboard: { rows: rows.map((buttons) => ({ row: { buttons } })) } } : {}),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true } } })
  const nodes = [
    code('Code - Readiness Ctx', ctxJs, 0),
    get('Supabase - Get Hotel (Readiness)', 'hotels', 1),
    get('Supabase - Get Photos (Readiness)', 'media', 2),
    get('Supabase - Get Insights (Readiness)', 'hotel_insights', 3),
    code('Code - Readiness Check', `const ctx = $('Code - Readiness Ctx').first().json;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const h = $('Supabase - Get Hotel (Readiness)').all().map(i => i.json).find(x => x && x.hotel_id === ctx.hotel_id);
if (!h || h.status !== 'needs_review') return [{ json: { act: 'none' } }];
const photos = $('Supabase - Get Photos (Readiness)').all().map(i => i.json).filter(x => x && x.media_id).length;
const cards = $('Supabase - Get Insights (Readiness)').all().map(i => i.json).filter(x => x && x.insight_id && x.status === 'confirmed').length;
const needPhotos = Math.max(0, ${MIN_PHOTOS} - photos);
const needCard = cards === 0;
const name = '<b>' + esc(h.name) + '</b>';
if (!needPhotos && !needCard) return [{ json: { act: 'promote', hotel_id: h.hotel_id, chat_id: ctx.chat_id,
  text: 'Готово ✅ ' + name + ' додано в роботу. Агент почне писати про нього з плану на наступний тиждень (неділя 19:00).' } }];
const lines = [];
if (needPhotos) lines.push('📸 ще ' + needPhotos + ' фото (зараз ' + photos + ' із ${MIN_PHOTOS}) — закинь у папку й натисни «✅ Фото готово»');
if (needCard) lines.push('🏨 розкажи про готель голосом — кнопка нижче');
return [{ json: { act: 'missing', need_card: needCard, hotel_id: h.hotel_id, chat_id: ctx.chat_id,
  text: name + ' ще не в роботі. Щоб агент почав про нього писати, бракує:\\n\\n' + lines.join('\\n') } }];`, 4),
    ifb('IF - Readiness Promote', '={{ $json.act === "promote" }}', 5),
    { id: nid('Supabase - Promote Hotel'), name: 'Supabase - Promote Hotel', type: 'n8n-nodes-base.supabase', typeVersion: 1, position: at(6), credentials: SB,
      parameters: { operation: 'update', tableId: 'hotels', filterType: 'manual', filters: { conditions: [{ keyName: 'hotel_id', condition: 'eq', keyValue: '={{ $json.hotel_id }}' }] },
        fieldsUi: { fieldValues: [{ fieldId: 'status', fieldValue: 'Active' }, { fieldId: 'content_status', fieldValue: 'Ready' }] } } },
    tg('Telegram - Send Hotel Ready', null, 7),
    ifb('IF - Readiness Missing', '={{ $json.act === "missing" }}', 6),
    ifb('IF - Readiness Need Card', '={{ $json.need_card }}', 7),
    tg('Telegram - Send Missing (Voice)', [[btnCb('🏨 Розповісти про готель', 'hotel_voice')]], 8),
    tg('Telegram - Send Missing', null, 8),
  ]
  // після Promote Hotel тексту вже нема в $json — беремо з Check
  nodes.find((n) => n.name === 'Telegram - Send Hotel Ready').parameters.text = "={{ $('Code - Readiness Check').first().json.text }}"
  nodes.find((n) => n.name === 'Telegram - Send Hotel Ready').parameters.chatId = "={{ $('Code - Readiness Check').first().json.chat_id }}"
  wf.nodes.push(...nodes)
  const L = (...x) => ({ main: [x.map((n) => ({ node: n, type: 'main', index: 0 }))] })
  const chain = ['Code - Readiness Ctx', 'Supabase - Get Hotel (Readiness)', 'Supabase - Get Photos (Readiness)', 'Supabase - Get Insights (Readiness)', 'Code - Readiness Check', 'IF - Readiness Promote']
  wf.connections[afterName] = L('Code - Readiness Ctx')
  for (let i = 0; i < chain.length - 1; i++) wf.connections[chain[i]] = L(chain[i + 1])
  wf.connections['IF - Readiness Promote'] = { main: [[{ node: 'Supabase - Promote Hotel', type: 'main', index: 0 }], [{ node: 'IF - Readiness Missing', type: 'main', index: 0 }]] }
  wf.connections['Supabase - Promote Hotel'] = L('Telegram - Send Hotel Ready')
  wf.connections['IF - Readiness Missing'] = { main: [[{ node: 'IF - Readiness Need Card', type: 'main', index: 0 }]] }
  wf.connections['IF - Readiness Need Card'] = { main: [[{ node: 'Telegram - Send Missing (Voice)', type: 'main', index: 0 }], [{ node: 'Telegram - Send Missing', type: 'main', index: 0 }]] }
}

// ───────────────────────── Hotel Voice Intake (Ira bot) ─────────────────────────
const HV_CANCEL = btnCb('❌ Скасувати', 'hv_cancel')
const HV_DONE = btnCb('✅ Це все', 'hv_done')
const HV_OK = btnCb('👍 Зберегти', 'hv_ok')
const HV_START = '«🏨 Розповісти про готель» у /help'

function buildVoice() {
  const wf = load('wf044_hotel_voice_intake_2026-11-16.json')
  removeNode(wf, 'Webhook - Manual Test')
  toIraBot(wf)
  // відкрита сесія — найсвіжіша не закрита (раніше limit 1 без гарантії порядку)
  const gs = byName(wf, 'Supabase - Get Open Session').parameters
  delete gs.limit; delete gs.orderBy; gs.returnAll = true
  swap(wf, 'Code - Merge Context', 'jsCode', "let session = rows[0] || null;",
    "rows.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));\nlet session = rows[0] || null;")
  swap(wf, 'Code - Build Hotel Picker', 'jsCode', "'У базі ще нема готелів. Спочатку додай їх через /upload.'", "'У базі ще нема готелів 🙈 Скажи Владу.'")
  swap(wf, 'Code - Build Hotel Picker', 'jsCode', "'Про який готель розповідаєш? Тапни на назву (вона скопіюється) і надішли її мені — або просто відповідай номером:\\n\\n'",
    "'🏨 Про який готель розповідаєш? Напиши номер зі списку (або назву):\\n\\n'")
  swap(wf, 'Code - Build Hotel Picker', 'jsCode', "'\\n\\nЩоб вийти — /cancel'", "''")
  swap(wf, 'Code - Parse Hotel Choice', 'jsCode', 'номер від 1 до ${opts.length} (або /cancel).', 'номер від 1 до ${opts.length} (або «❌ Скасувати»).')
  swap(wf, 'Code - Parse Insight', 'jsCode', "Якщо все вірно — напиши «ок». Якщо щось не так — надішли правку (голосовим або текстом).",
    "Якщо все вірно — натисни «👍 Зберегти». Якщо щось не так — надішли правку (голосовим або текстом).")
  swap(wf, 'Code - Parse Insight', 'jsCode', "Якщо додати нічого — напиши «все».", "Якщо додати нічого — натисни «✅ Це все».")
  swap(wf, 'Code - Parse Insight', 'jsCode', "Напиши «все» ще раз.", "Натисни «✅ Це все» ще раз.")
  swap(wf, 'Telegram - Send Cancel Reply', 'text', 'Щоб розповісти про готель — /voice', 'Щоб розповісти про готель — кнопка ' + HV_START + '.')
  swap(wf, 'Telegram - Send No Session Reply', 'text', 'Напиши /voice, щоб почати.', 'Щоб почати — кнопка ' + HV_START + '.')
  swap(wf, 'Telegram - Send Collect Prompt', 'text', 'Коли закінчиш — напиши «все».', 'Коли закінчиш — натисни «✅ Це все» під моєю відповіддю.')
  swap(wf, 'Telegram - Send Ack', 'text', 'Якщо все — напиши «все».', 'Якщо все — натисни «✅ Це все».')
  swap(wf, 'Telegram - Send Saved Reply', 'text', 'Щоб розповісти про інший — /voice', 'Щоб розповісти про інший — кнопка ' + HV_START + '.')
  addReadiness(wf, 'Telegram - Send Saved Reply', "const c = $('Code - Build Insight Row').first().json;\nreturn [{ json: { hotel_id: c.hotel_id, chat_id: c.chat_id } }];")
  keyboard(wf, 'Telegram - Send Hotel Picker', [[HV_CANCEL]])
  keyboard(wf, 'Telegram - Send Collect Prompt', [[HV_CANCEL]])
  keyboard(wf, 'Telegram - Send Ack', [[HV_DONE, HV_CANCEL]])
  keyboard(wf, 'Telegram - Send Gap Questions', [[HV_DONE]])
  keyboard(wf, 'Telegram - Send Card', [[HV_OK, HV_CANCEL]])
  keyboard(wf, 'Telegram - Send Structure Error', [[HV_DONE]])
  toIraBot(wf)
  return finish(wf, '[TravelLab] Hotel Voice Intake (Ira bot)')
}

// ───────────────────────── Media Intake (Ira bot) ─────────────────────────
const PHOTO = '«📷 Фото готелю»'
const ISLAND = '«🏝 Фото острова»'

function buildMedia(voiceId) {
  const wf = load('wf022_media_intake_2026-11-16.json')
  removeNode(wf, 'Telegram Trigger')
  removeNode(wf, 'Webhook - Manual Test')
  const route = byName(wf, 'Code - Route Message')
  wf.nodes.push({ id: 'execute-workflow-trigger', name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1,
    position: [route.position[0] - 220, route.position[1]], parameters: { inputSource: 'passthrough' } })
  wf.connections['Execute Workflow Trigger'] = { main: [[{ node: 'Code - Route Message', type: 'main', index: 0 }]] }
  toIraBot(wf)
  byName(wf, 'Execute Workflow - Hotel Voice Intake').parameters.workflowId = { __rl: true, value: voiceId, mode: 'id' }

  // «➕ Новий готель»: /newhotel Назва | Країна → HTL-XXX з країною (чернетка needs_review; Active+Ready — коли ≥ 5 фото і є картка)
  swap(wf, 'Code - Route Message', 'jsCode', "let createNew = false;", "let createNew = false;\nlet newCountry = '';")
  swap(wf, 'Code - Route Message', 'jsCode', "  hotelQuery = newHotelMatch[1].trim();\n  createNew = true;",
    "  const nhParts = newHotelMatch[1].split('|');\n  hotelQuery = nhParts[0].trim();\n  newCountry = (nhParts[1] || '').trim();\n  createNew = true;")
  swap(wf, 'Code - Route Message', 'jsCode', "create_new: createNew }", "create_new: createNew, new_country: newCountry }")
  swap(wf, 'Code - Check Hotel Found (Upload)', 'jsCode', "  create_new: routeData.create_new === true,\n", "  create_new: routeData.create_new === true,\n  new_country: routeData.new_country || '',\n")
  swap(wf, 'Code - Generate Stub Hotel', 'jsCode', "country: 'Уточнити',", "country: checkData.new_country || 'Уточнити',")
  swap(wf, 'Code - Format New Hotel', 'jsCode', "chat_id: ctx.chat_id, is_new_hotel: true", "chat_id: ctx.chat_id, is_new_hotel: true, country: ctx.country")
  setCode(wf, 'Code - Build Upload Reply', `const c = $json;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = '📷 <b>' + esc(c.hotel_name) + '</b>\\n\\nЗакинь фото в папку (кнопка нижче):\\n'
  + '• телефон: Google Диск → «+» → Завантажити → Фото й відео. Не закривай Диск, поки не завантажиться;\\n'
  + '• компʼютер: перетягни файли.\\n\\n'
  + 'Коли все завантажиться — натисни «✅ Фото готово». Я опишу нові фото, старі не чіпаю.';
const text2 = c.is_new_hotel
  ? '➕ <b>' + esc(c.hotel_name) + '</b> додано (' + c.hotel_id + (c.country && c.country !== 'Уточнити' ? ', ' + esc(c.country) : '') + ')\\n\\nЩо далі, 3 кроки:\\n'
    + '1️⃣ Закинь мінімум 5 фото в папку (кнопка нижче): телефон — Google Диск → «+» → Завантажити → Фото й відео, компʼютер — перетягни файли.\\n'
    + '2️⃣ Натисни «✅ Фото готово» — я опишу фото.\\n'
    + '3️⃣ Розкажи про готель голосом — «🏨 Розповісти про готель» у /help (я підкажу кнопкою).\\n\\n'
    + 'Коли буде і те, і те — агент почне писати про готель з плану на наступний тиждень (неділя 19:00).'
  : text;
return [{ json: { chat_id: c.chat_id, reply_text: text2, folder_link: c.folder_link, hotel_id: c.hotel_id } }];`)
  keyboard(wf, 'Telegram - Send Upload Reply', [
    [btnUrl('📂 Відкрити папку', '={{ $json.folder_link }}')],
    [btnCb('✅ Фото готово', "={{ 'ph_ready_' + $json.hotel_id }}")],
  ])

  swap(wf, 'Code - Build Summary Reply (Ready)', 'jsCode', "return [{ json: { chat_id: ctx.chat_id, reply_text: text } }];", "return [{ json: { chat_id: ctx.chat_id, reply_text: text, hotel_id: ctx.hotel_id } }];")
  addReadiness(wf, 'Telegram - Send Summary Reply (Ready)', "const c = $('Code - Build Summary Reply (Ready)').first().json;\nreturn [{ json: { hotel_id: c.hotel_id, chat_id: c.chat_id } }];")
  // острів: назва — у прихованому посиланні (callback_data до 64 байт, кирилиця не влазить); WF-055 читає її з повідомлення
  setCode(wf, 'Code - Build Island Upload Reply', `const c = $json;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mark = 'https://t.me/travellab_studio_bot?start=isl_' + encodeURIComponent(c.island_name);
const text = '<a href="' + esc(mark) + '">\\u200b</a>🏝 <b>' + esc(c.island_name) + '</b>\\n\\nЗакинь фото острова в папку (кнопка нижче) — пляжі, вид, атмосфера, без привʼязки до готелю.\\n\\n'
  + 'Коли все завантажиться — натисни «✅ Фото готово».';
return [{ json: { chat_id: c.chat_id, reply_text: text, folder_link: c.folder_link } }];`)
  keyboard(wf, 'Telegram - Send Island Upload Reply', [
    [btnUrl('📂 Відкрити папку', '={{ $json.folder_link }}')],
    [btnCb('✅ Фото готово', 'isl_ready')],
  ])

  setCode(wf, 'Code - Build Hotel Not Found Reply (Ready)', `const c = $json;
const text = 'Не знайшов готель «' + c.hotel_query + '» у базі 🤔 Натисни ${PHOTO} у /help і вибери готель зі списку.';
return [{ json: { chat_id: c.chat_id, reply_text: text } }];`)
  setCode(wf, 'Code - Build No Folder Reply (Ready)', `const c = $json;
const text = 'Ще нема папки для «' + c.hotel_name + '» 🤔 Натисни ${PHOTO} у /help, вибери готель — дам папку.';
return [{ json: { chat_id: c.chat_id, reply_text: text } }];`)
  setCode(wf, 'Code - Build Nothing New Reply (Ready)', `const c = $json;
const text = 'Перевірив папку «' + c.hotel_name + '» — нових фото не знайшов 🤷\\n\\nЯкщо щойно завантажувала — почекай хвилинку, поки Диск докачає, і натисни «✅ Фото готово» ще раз.';
return [{ json: { chat_id: c.chat_id, reply_text: text } }];`)
  setCode(wf, 'Code - Build Island No Folder Reply', `const c = $json;
const text = 'Ще нема папки для острова «' + c.island_name + '» 🤔 Натисни ${ISLAND} у /help — дам папку.';
return [{ json: { chat_id: c.chat_id, reply_text: text } }];`)
  setCode(wf, 'Code - Build Island Nothing New Reply', `const c = $json;
const text = 'Перевірив папку острова «' + c.island_name + '» — нових фото не знайшов 🤷\\n\\nЯкщо щойно завантажувала — почекай хвилинку й натисни «✅ Фото готово» ще раз.';
return [{ json: { chat_id: c.chat_id, reply_text: text } }];`)
  // нові готелі — сет 2 (кнопка в апці); тут лише підказка
  setCode(wf, 'Code - Build Not Found Upload Reply', `const c = $json;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let t = 'Не знайшов готель «' + esc(c.hotel_query) + '» у базі 🙈\\n\\n';
if (c.similar && c.similar.length) t += 'Може, це один із цих?\\n' + c.similar.map(n => '• ' + esc(n)).join('\\n') + '\\n\\n';
t += 'Натисни ${PHOTO} у /help — там увесь список з номерами. Новий готель? Натисни «➕ Новий готель» у /help.';
return [{ json: { chat_id: c.chat_id, reply_text: t } }];`)
  swap(wf, 'Code - Build Hotel List Reply', 'jsCode', "'У базі поки нема жодного готелю. Напиши /upload [назва готелю], щоб додати перший.'", "'У базі поки нема жодного готелю 🙈'")
  swap(wf, 'Code - Build Hotel List Reply', 'jsCode', 'Тапни на назву щоб скопіювати, потім напиши /upload [назва] або "готово, [назва]".',
    `Фото готелю — кнопка ${PHOTO}, розповісти про готель — «🏨 Розповісти про готель» (обидві в /help).`)
  toIraBot(wf)
  return finish(wf, '[TravelLab] Media Intake (Ira bot)')
}

const VOICE_ID = process.env.TL_HOTEL_VOICE_ID || 'ELqmuNDOcpIX6N5m'
writeFileSync(join(here, 'hotel_voice.json'), JSON.stringify(buildVoice(), null, 2))
writeFileSync(join(here, 'media_intake.json'), JSON.stringify(buildMedia(VOICE_ID), null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped → n8n/hotel_voice.json + n8n/media_intake.json')
else {
  const mcp = JSON.parse(readFileSync(join(here, '..', '..', '..', '.mcp.json'), 'utf8'))
  const env = (mcp.mcpServers || mcp)['n8n-mcp'].env
  const base = env.N8N_API_URL.replace(/\/$/, '')
  const api = base.endsWith('/api/v1') ? base : base + '/api/v1'
  const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' }
  const send = async (id, wf) => {
    const r = await fetch(id ? `${api}/workflows/${id}` : `${api}/workflows`, { method: id ? 'PUT' : 'POST', headers, body: JSON.stringify(wf) })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch {}
    console.log(r.status, j ? `${j.id} ${j.name} active=${j.active}` : t.slice(0, 500))
    return j
  }
  if (mode === 'create') {
    const v = await send(null, buildVoice())
    if (v?.id) await send(null, buildMedia(v.id))
  } else if (mode === 'update') {
    await send(process.argv[3], buildVoice())
    if (process.argv[4]) await send(process.argv[4], buildMedia(process.argv[3]))
  }
}

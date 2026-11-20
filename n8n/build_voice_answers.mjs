// node n8n/build_voice_answers.mjs [dump | create | update <coreId> <botId>]
// Голос через бот Іри (рішення #1 плану): кнопка в апці «Відповісти голосом» → t.me/<бот>?start=answer_<plan_id> →
// бот ставить саме ці питання → Іра одне голосове (або текст) у відповідь → Whisper → gpt-4.1 розкладає по питаннях →
// data_requests answered (answered_via voice_bot) → «Дякую! Записав: … Дописую пост» + web_app «Повернутись у TravelLab» →
// Data Answer (той самий шлях, що й відповідь з апки) → «✨ Нова версія готова».
//
// Два воркфлоу:
//  1) «[TravelLab] Voice Answers (Mini App)» — ядро. Тригери: Execute Workflow (з бота) і тестовий вебхук
//     travellab-bot-update-test (Header Auth, тіло = Telegram update). Відповідає лише в чат автора апдейту
//     і лише Ірі / Владу (settings.ira_chat_id / admin_chat_id); решту ігнорує.
//  2) «[TravelLab] Ira Bot (updates)» — Telegram Trigger на бот Іри → ядро. НЕАКТИВНИЙ: активація = setWebhook бота Іри.
//     Перед активацією перевірити getWebhookInfo (url має бути порожній), потім settings.voice_answers = "on" (кнопка в апці).
// Стан розмови не зберігаємо: питання бот шле з force_reply і прихованим посиланням на пост; відповідь Іри = reply на нього.
// Не reply (просто голосове) → якщо в «бракує даних» рівно один пост — до нього; нема жодного — це історія; інакше просимо відповісти на питання.
//
// «🎙 Розповісти історію» (14.10): /story, /start story (кнопка в апці й дайджесті) або текст «🎙 Розповісти історію» → бот
// ставить питання-підказку тижня (settings.story_prompts, n8n/story_prompt.mjs) з force_reply і прихованим маркером
// ?start=story → голосове/текст у відповідь → Whisper → gpt-4.1 чистить розшифровку (її слова, без вигадок) + готель/країна →
// story_queue (pillar personal_experience, status new) → WF-018 бере найстарішу в суботній слот наступного тижня.
// «Коли публікувати» (16.11): після запису — кнопки st_now_ / st_tmr_ / st_week_<story_id>. Сьогодні/Завтра →
// замок на історію (new → used) → новий TG-слот content_plan на цю дату (review_status generating, note порожній —
// без теми/аудиторії тижня) → Post Generator (той самий, що в Buffer Filler) → фото → tl_add_version → Ірі «готово»
// з кнопкою на пост. Не вийшло → слот назад у planned (або історія назад у new) + Владу. «У план тижня» → як було (WF-018).
//
// «🎬 Відео» (21.10, тест рілсів): /video (або /start video) → посилання на Travel lab/00_Inbox; «відео готово» →
// бот рахує відео в Inbox і його підпапках (Drive Іри) → Ірі підсумок, Владу (admin_chat_id) — «можна розбирати».
// Розбір і монтаж поки робить Claude на Mac (Reels_Test_Plan_2026-10-21), потім — воркер на VPS.
// «🎙 Голос до відео» (26.10, сет 6): кнопка в апці «Озвучити голосом» → /start vo_<draft_id> → бот просить голосове
// з force_reply і прихованим маркером ?start=vo_<id> → голосове у відповідь → заявка video_drafts.remount {kind: voice, file_id}
// (лише якщо відео не монтується) → воркер на Mac (montage-test/remount_worker.py): очистка, Whisper, субтитри, кадри під голос.
// «✅ Виклала» (26.10, сет 7): Vercel /api/publish у слот шле Ірі в чат готове відео + підпис з кнопкою callback vpub_<draft_id> →
// video_drafts.published_at (лише якщо ще порожньо) → «Позначила ✅» + кнопка відкрити відео в апці.
// /help або /start — меню кнопок (усі дії без набору тексту). Кнопки callback (video_ask / video_ready / story / help)
// = ті самі команди: Normalize перетворює callback_query на текст, бот одразу відповідає answerCallbackQuery.
// «📷 Фото готелю / 🏝 Фото острова / 🏨 Розповісти про готель» (16.11, сет 1 Ira_Knowledge_Intake_Design): переїхали з test_mergebot.
// Фото: бот дає нумерований список (force_reply, маркер ?start=photo / ?start=island) → номер або назва → підворкфлоу
// «Media Intake (Ira bot)» (n8n/build_media_intake.mjs, копія WF-022) з командою /upload / /island → папка + «✅ Фото готово»
// (callback ph_ready_<HTL> / isl_ready, назва острова — у прихованому посиланні повідомлення) → «готово, …» → Vision → media.
// Голос про готель: /voice (кнопка hotel_voice) → «Hotel Voice Intake (Ira bot)» (копія WF-044, сесії intake_sessions).
// Поки сесія відкрита (не closed, ≤ 24 год), звичайні голосові й текст без reply йдуть туди; кнопки hv_done / hv_ok / hv_cancel = «все» / «ок» / /cancel.
// Старі текстові команди (/upload X, «готово, X», /island X, «острів готово, X», /hotels) теж працюють.
import { readFileSync, writeFileSync } from 'node:fs'
import { STORY_HINT_JS, STORY_MARK_RE } from './story_prompt.mjs'
import { RULES_JS } from './ira_rules.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  // [TravelLab] Data Answer (Mini App) — n8n/build_data_answer.mjs
  dataAnswerId: process.env.TL_DATA_ANSWER_ID || '7LRWGhCgnoM8MXmW',
  drive: { id: 'cjY7BSZAIddR6oLs', name: 'Google Drive Іра' },
  // Travel lab/00_Inbox на Drive Іри — сюди вона кидає відео (/video), розбір — після «відео готово»
  inboxId: '1py-eratM0G1dr8gGI94PXJMx7DziXk9K',
  // Post Generator (PRMPT-011 v5) — той самий, що в Buffer Filler / WF-046
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
  // фото й голос про готель (сет 1) — n8n/build_media_intake.mjs
  mediaIntakeId: process.env.TL_MEDIA_INTAKE_ID || 'sBBQxK3jVtK6LmoQ',
  hotelVoiceId: process.env.TL_HOTEL_VOICE_ID || 'ELqmuNDOcpIX6N5m',
  // Travel lab/Destinations на Drive Іри — папки островів (/island)
  destinationsId: '1R4jAWrdB-xMzB5Mf7BdCgGfX1J5ogpOV',
}
const sb = { supabaseApi: CFG.supabase }
const tgc = { credentials: { telegramApi: CFG.telegram } }
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

// ───────────────────────── Code ─────────────────────────
const normalize = `// Telegram update (з тригера бота або з тестового вебхука) → що хоче людина
const b = $json.body && typeof $json.body === 'object' && ($json.body.message || $json.body.callback_query || $json.body.update_id) ? $json.body : $json;
// натиснута кнопка = та сама команда текстом
const CB = { video_ask: '/video', video_ready: 'відео готово', story: '/story', help: '/help', photo_hotel: '/photo', photo_island: '/island', hotel_voice: '/voice', hotel_new: '/newhotel', hv_cancel: '/cancel' };
const cq = b.callback_query || null;
const cbData = cq ? String(cq.data || '') : '';
// «✅ Фото готово» під папкою готелю / острова (назва острова — у прихованому посиланні того ж повідомлення)
const phr = cbData.match(/^ph_ready_(HTL-\\d+)$/i);
let islandReady = null;
if (cbData === 'isl_ready' && cq.message) {
  for (const e of [...(cq.message.entities || []), ...(cq.message.caption_entities || [])]) {
    const mi = String(e.url || '').match(/[?&]start=isl_(.+)$/);
    if (mi) { try { islandReady = decodeURIComponent(mi[1]).trim(); } catch (err) { islandReady = null; } break; }
  }
}
// кнопки під розмовою про готель → ті самі слова, що Іра писала текстом
const hvText = cbData === 'hv_done' ? 'все' : cbData === 'hv_ok' ? 'ок' : null;
// «✅ Виклала» під відео, яке бот надіслав у слот (server/video_publish.ts)
const vp = cq ? String(cq.data || '').match(/^vpub_([0-9a-f-]{36})$/i) : null;
// «Пост виклала?» (21.11, сет 1): кнопки ✅ Виклала / 📅 На завтра / ⏭ Не буду під запитом WF-050 → callback ppub_ / ptmr_ / pskip_ + id поста
const pp = cq ? String(cq.data || '').match(/^pp(pub|tmr|skip)_([0-9a-f-]{36})$/i) : null;
// «🔥 Сьогодні / 📅 Завтра / 🗓 У план тижня» під записаною історією
const sw = cq ? String(cq.data || '').match(/^st_(now|tmr|week)_([0-9a-f-]{36})$/i) : null;
const m = cq ? { chat: cq.message && cq.message.chat, from: cq.from, text: CB[cq.data] || '/help' } : (b.message || {});
const text = String(m.text || m.caption || '').trim();
const file = (m.voice && m.voice.file_id) || (m.audio && m.audio.file_id) || (m.video_note && m.video_note.file_id) || null;
const audio = (m.voice || m.audio) ? { file_id: (m.voice || m.audio).file_id, dur: Number((m.voice || m.audio).duration || 0) } : null;
let planId = null, how = 'none', videoId = null, nhName = '';
// «🎙 Озвучити голосом» з апки: /start vo_<id> — голос до відео
const vo = text.match(/^\\/start(?:@\\w+)?\\s+vo_([0-9a-f-]{36})\\b/i);
if (vo) videoId = vo[1].toLowerCase();
if (vp) videoId = vp[1].toLowerCase();
if (pp) planId = pp[2].toLowerCase();
const st = text.match(/^\\/start(?:@\\w+)?\\s+answer_([0-9a-f-]{36})\\b/i);
if (st) { planId = st[1].toLowerCase(); how = 'start'; }
// «Розповісти історію»: команда, deep link з апки/дайджесту або кнопка-текст
const storyCmd = /^\\/story(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+story$/i.test(text) || /розповісти історію/i.test(text);
// «🎬 Відео»: посилання на Inbox і «відео готово» після завантаження
const videoCmd = /^\\/video(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+video$/i.test(text) || /^(🎬\\s*)?завантажити відео$/i.test(text);
const videoReady = /^(\\/videodone(?:@\\w+)?|відео\\s+готов[оі]?)[.!\\s]*$/i.test(text);
// фото готелю / острова, голос про готель (переїхали з test_mergebot)
const photoCmd = /^\\/(photo|upload)(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+photo$/i.test(text);
const islandCmd = /^\\/island(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+island$/i.test(text);
const hvCmd = /^\\/voice(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+hotel$/i.test(text);
const hvCancel = /^\\/cancel(?:@\\w+)?$/i.test(text);
const hotelsCmd = /^\\/hotels(?:@\\w+)?$/i.test(text);
// «➕ Новий готель» (сет 2, 21.11): /newhotel без назви або кнопка → кроки назва → (схожі) → країна; /newhotel Назва | Країна — одразу в Media Intake
const newCmd = /^\\/newhotel(?:@\\w+)?$/i.test(text) || /^\\/start(?:@\\w+)?\\s+newhotel$/i.test(text);
const mediaTyped = /^\\/(upload|island|newhotel)(?:@\\w+)?\\s+\\S/i.test(text) || /^(острів\\s+)?готово(?:[,:]\\s*|\\s+)\\S/i.test(text);
const helpCmd = /^\\/(help|start)(?:@\\w+)?$/i.test(text);
const r = m.reply_to_message;
if (!planId && r) {
  for (const e of [...(r.entities || []), ...(r.caption_entities || [])]) {
    const u = String(e.url || '');
    const mm = u.match(/post_([0-9a-f-]{36})/i);
    if (mm) { planId = mm[1].toLowerCase(); how = 'reply'; break; }
    const mv = u.match(/start=vo_([0-9a-f-]{36})/i);
    if (mv) { videoId = mv[1].toLowerCase(); how = 'vo'; break; }
    if (${STORY_MARK_RE}.test(u)) { how = 'story'; break; }
    if (/[?&]start=photo$/.test(u)) { how = 'photo'; break; }
    if (/[?&]start=island$/.test(u)) { how = 'island'; break; }
    if (/[?&]start=newhotel$/.test(u)) { how = 'nh'; break; }
    const mn = u.match(/[?&]start=(nhc|nhd)_(.+)$/);
    if (mn) { how = mn[1]; try { nhName = decodeURIComponent(mn[2]).trim(); } catch (err) { nhName = ''; } break; }
  }
}
let route = 'ignore', mediaText = null, hvBranch = null;
if (!m.chat || !m.from || m.from.is_bot) route = 'ignore';
else if (vp) route = 'vpub';
else if (pp) route = 'ppost';
else if (sw) route = 'story_when';
else if (vo) route = 'vo_ask';
else if (how === 'vo') route = 'vo';
else if (st) route = 'ask';
else if (phr) route = 'photo_ready';
else if (cbData === 'isl_ready') { route = islandReady ? 'media' : 'help'; if (islandReady) mediaText = 'острів готово, ' + islandReady; }
else if (hvText) { route = 'hv'; hvBranch = 'voice_session'; }
else if (hvCancel && !file) { route = 'hv'; hvBranch = 'voice_cancel'; }
else if (hvCmd && !file) { route = 'hv'; hvBranch = 'voice_start'; }
else if (newCmd && !file) route = 'nh';
else if ((how === 'nh' || how === 'nhc' || how === 'nhd') && text && !file) route = 'nh';
else if (photoCmd && !file) route = 'photo_ask';
else if (islandCmd && !file) route = 'island_ask';
else if (hotelsCmd && !file) { route = 'media'; mediaText = '/hotels'; }
else if (mediaTyped && !file) { route = 'media'; mediaText = text; }
else if (how === 'photo' && text && !file) route = 'photo_pick';
else if (how === 'island' && text && !file) route = 'island_pick';
else if (videoCmd && !file) route = 'video_ask';
else if (videoReady && !file) route = 'video_ready';
else if (storyCmd && !file) route = 'story_ask';
else if (how === 'story' && (file || text)) route = 'story';
else if (file || (text && how === 'reply')) route = 'answer';
else if (text) route = 'help';
return [{ json: { route, plan_id: planId, video_id: videoId, story_id: sw ? sw[2].toLowerCase() : null, when: sw ? sw[1].toLowerCase() : null, audio, how, chat_id: m.chat ? String(m.chat.id) : '', from_id: m.from ? String(m.from.id) : '', text: file ? '' : text, file_id: file, callback_id: cq ? cq.id : null, pp_action: pp ? pp[1].toLowerCase() : null,
  media_text: mediaText, nh_name: nhName, hv_branch: hvBranch, hv_text: hvText, hotel_id: phr ? phr[1].toUpperCase() : null, explicit_help: helpCmd || cbData === 'help' } }];`

const resolve = `// Хто пише (лише Іра / Влад), до якого поста, які відкриті питання
const n = $('Code - Normalize').first().json;
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const s = {};
for (const r of all('Supabase - Get Settings')) s[r.key] = r.value;
const aud = all('Supabase - Get Audiences');
${STORY_HINT_JS}
const allowed = [s.ira_chat_id, s.admin_chat_id].filter(Boolean).map(String);
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
const bot = String(s.bot_username || 'travellab_studio_bot').replace(/^@/, '');
const out = { ...n, mini_app_url: base, supabase_url: String(s.supabase_url || '').replace(/\\/$/, ''), story_url: 'https://t.me/' + bot + '?start=story', admin_chat_id: String(s.admin_chat_id || ''),
  photo_url: 'https://t.me/' + bot + '?start=photo', tg_start: 'https://t.me/' + bot + '?start=', island_url: 'https://t.me/' + bot + '?start=island' };
if (n.route === 'ignore' || !allowed.includes(n.from_id)) return [{ json: { ...out, route: 'ignore' } }];
// Розмова про готель відкрита (не closed, ≤ 24 год) → звичайне голосове / текст без reply і без команди йдуть у неї
const ses = all('Supabase - Get Intake Session').filter(x => x.session_id && x.status !== 'closed')
  .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
const hvOpen = !!ses && Date.now() - new Date(ses.updated_at || ses.created_at).getTime() <= 24 * 3600 * 1000;
if (hvOpen && ((n.route === 'help' && !n.explicit_help) || (n.route === 'answer' && n.how === 'none'))) return [{ json: { ...out, route: 'hv', hv_branch: 'voice_session' } }];
if (n.route === 'hv' || n.route === 'media' || n.route === 'island_ask' || n.route === 'island_pick') return [{ json: out }];
const hotelList = () => all('Supabase - Get Hotels').filter(h => h.hotel_id && h.name)
  .sort((a, b) => String(a.name).localeCompare(String(b.name), 'uk')).map(h => ({ id: h.hotel_id, name: h.name, country: h.country || '' }));
if (n.route === 'photo_ask' || n.route === 'photo_pick' || n.route === 'nh') return [{ json: { ...out, hotels: hotelList() } }];
if (n.route === 'photo_ready') {
  const h = hotelList().find(x => x.id === n.hotel_id);
  return [{ json: h ? { ...out, route: 'media', media_text: 'готово, ' + h.name } : { ...out, route: 'photo_gone' } }];
}
if (n.route === 'video_ask' || n.route === 'video_ready') return [{ json: out }];
if (n.route === 'story_ask') return [{ json: { ...out, ...storyHint() } }];
if (n.route === 'story') return [{ json: out }];
if (n.route === 'story_when') {
  // Дата й час нового TG-слота: завтра — час TG за замовчуванням (settings.slot_times перекриває, як server/schedule.ts);
  // сьогодні — не раніше ніж за годину від зараз (кругла година), не пізніше 23:00. Іра змінить у календарі апки
  const story = all('Supabase - Get Story')[0] || null;
  const now = DateTime.now().setZone('Europe/Kyiv');
  const d = n.when === 'tmr' ? now.plus({ days: 1 }) : now;
  let times = s.slot_times;
  if (typeof times === 'string') { try { times = JSON.parse(times); } catch (e) { times = {}; } }
  const def = /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String((times || {}).telegram || '')) ? String(times.telegram) : '10:00';
  let time = def;
  if (n.when === 'now') {
    let e = now.plus({ minutes: 60 });
    if (e.minute || e.second || e.millisecond) e = e.startOf('hour').plus({ hours: 1 });
    const t = e.hasSame(now, 'day') ? e.toFormat('HH:mm') : '23:00';
    if (t > def) time = t > '23:00' ? '23:00' : t;
  }
  const date = d.toFormat('yyyy-MM-dd');
  const plan_row = story ? {
    day: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'][d.weekday - 1], platform: 'telegram', slot_type: 'content',
    pillar: story.pillar || 'personal_experience', tour_id: null, hotel_id: story.hotel_id || null, story_id: story.id, pair_key: null,
    note: null, status: 'draft', week_start: d.startOf('week').toFormat('yyyy-MM-dd'), scheduled_for: date, slot_time: time, review_status: 'generating'
  } : null;
  return [{ json: { ...out, story, date, date_label: d.toFormat('dd.MM'), time, plan_row } }];
}
if (n.route === 'ppost') {
  // ✅ Виклала → published; 📅 На завтра → дата +1 день; ⏭ Не буду → skipped. Лише для ще затверджених (повторне натискання нічого не ламає)
  const p = all('Supabase - Get Plans')[0] || {};
  const hn = ((p.hotel_id && all('Supabase - Get Hotels').find(h => h.hotel_id === p.hotel_id)) || {}).name;
  const tn = ((p.tour_id && all('Supabase - Get Tours').find(t => t.tour_id === p.tour_id)) || {}).title;
  const nowK = DateTime.now().setZone('Europe/Kyiv');
  const stamp = new Date().toISOString();
  const row = n.pp_action === 'pub' ? { review_status: 'published', published_at: stamp, updated_at: stamp }
    : n.pp_action === 'tmr' ? { scheduled_for: nowK.plus({ days: 1 }).toFormat('yyyy-MM-dd'), updated_at: stamp }
    : { review_status: 'skipped', updated_at: stamp };
  return [{ json: { ...out, pp: { id: n.plan_id, action: n.pp_action, title: hn || tn || p.pillar || 'пост', tmr: nowK.plus({ days: 1 }).toFormat('dd.MM') }, row,
    post_url: base ? base + '/?startapp=post_' + n.plan_id : base } }];
}
if (n.route === 'vpub') {
  const v = all('Supabase - Get Video Draft')[0] || null;
  if (!v || v.status === 'skipped') return [{ json: { ...out, route: 'vo_gone' } }];
  return [{ json: { ...out, video: { id: v.id, name: v.name, format: v.format, published_at: v.published_at || null },
    row: { published_at: new Date().toISOString(), published_ref: { ...(v.published_ref || {}), posted_via: 'bot', posted_by: Number(n.from_id) } },
    video_url: base ? base + '/?startapp=video_' + v.id : base } }];
}
if (n.route === 'vo_ask' || n.route === 'vo') {
  const v = all('Supabase - Get Video Draft')[0] || null;
  if (!v || v.status === 'skipped') return [{ json: { ...out, route: 'vo_gone' } }];
  return [{ json: { ...out, video: { id: v.id, name: v.name, format: v.format, has_voice: !!(v.montage && v.montage.voice) },
    vo_url: 'https://t.me/' + bot + '?start=vo_' + v.id, video_url: base ? base + '/?startapp=video_' + v.id : base } }];
}

const reqs = all('Supabase - Get Open Requests');
const forPlan = (p) => reqs.filter(q => q.content_plan_id === p.id || (p.hotel_id && q.hotel_id === p.hotel_id) || (p.tour_id && q.tour_id === p.tour_id))
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const plans = all('Supabase - Get Plans');
let plan = n.plan_id ? plans.find(p => p.id === n.plan_id) || null : null;
if (!plan && !n.plan_id && n.route === 'answer') {
  // просто голосове, не відповідь на питання: якщо «бракує даних» рівно в одному пості — до нього
  const c = plans.filter(p => p.review_status === 'needs_data' && !p.published_at && forPlan(p).length);
  if (c.length === 1) plan = c[0];
  // жодного поста з питаннями, а голосове є → це історія для постів
  if (!c.length && n.file_id) return [{ json: { ...out, route: 'story', how: 'plain' } }];
}
if (n.route === 'help') return [{ json: { ...out, route: 'help' } }];
if (!plan) return [{ json: { ...out, route: n.plan_id ? 'gone' : 'unresolved' } }];

const hotels = Object.fromEntries(all('Supabase - Get Hotels').map(h => [h.hotel_id, h]));
const tours = Object.fromEntries(all('Supabase - Get Tours').map(t => [t.tour_id, t]));
const plat = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }[plan.platform] || plan.platform;
const title = ((plan.hotel_id && hotels[plan.hotel_id]) || {}).name || ((plan.tour_id && tours[plan.tour_id]) || {}).title || plan.pillar;
const qs = forPlan(plan).map(q => ({ id: q.id, field: q.field, question: q.question }));
return [{ json: { ...out, plan, title: title + ' · ' + plat, questions: qs, post_url: base ? base + '/?startapp=post_' + plan.id : '' } }];`

// HTML-повідомлення з force_reply: приховане посилання на пост (щоб відповідь Іри знала, до якого поста)
const esc = `const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hidden = (url) => url ? '<a href="' + esc(url) + '">\\u200b</a>' : '';
const list = (qs) => qs.map((q, i) => (qs.length > 1 ? (i + 1) + '. ' : '') + esc(q.question)).join('\\n');`

const ask = `${esc}
// /start answer_<id>: бот ставить саме питання цього поста
const r = $json;
if (!r.questions.length) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'По цьому посту питань уже немає 🙌', url: r.post_url, button: 'Повернутись у TravelLab' } }];
return [{ json: {
  chat_id: r.chat_id, kind: 'force',
  text: hidden(r.post_url) + '<b>' + esc(r.title) + '</b>\\nАгенту бракує ' + (r.questions.length === 1 ? 'одного факту' : 'кількох фактів') + ':\\n\\n' + list(r.questions)
    + '\\n\\n🎙 Запиши одне голосове з відповідями ' + (r.questions.length > 1 ? 'на всі питання' : '') + ' — у відповідь на це повідомлення. Можна й текстом.'
} }];`

const simple = `// help / unresolved / gone / нема питань — коротко + кнопка в апку
const r = $json;
const T = {
  help: 'Привіт! Я бот TravelLab. Що я вмію — тисни кнопку нижче:\\n\\n'
    + '📱 Відкрити TravelLab — пости на перегляд: затвердити, попросити правку, вибрати фото.\\n\\n'
    + '📷 Фото готелю — вибереш готель, дам папку на Диску. Закинь фото й натисни «✅ Фото готово» — я їх опишу для постів.\\n\\n'
    + '🏝 Фото острова — те саме для місця без готелю: пляжі, вид, атмосфера.\\n\\n'
    + '🏨 Розповісти про готель — голосом: чим особливий, кому підходить і кому ні, мінуси, твоє враження. Запишу в досьє готелю — це піде в усі пости про нього.\\n\\n'
    + '🎙 Розповісти історію — запишеш голосове, я зроблю з нього пост.\\n\\n'
    + '🎬 Завантажити відео — дам папку на Диску. Закинь туди відео з телефона чи компʼютера, повернись сюди й натисни «✅ Відео готово».\\n\\n'
    + '❓ Питання агента до поста — відкрий пост в апці й натисни «Відповісти голосом».\\n\\n'
    + 'Загубила меню — напиши /help.',
  unresolved: 'Не зрозумів, до якого поста ця відповідь 🙈 Відкрий пост у TravelLab і натисни «Відповісти голосом» — я поставлю питання ще раз.\\n\\nЯкщо це історія для постів — надішли /story і запиши її у відповідь.',
  gone: 'Цього поста вже немає в роботі 🙌',
  vo_gone: 'Цього відео вже немає в роботі 🙌',
  photo_gone: 'Не знайшов цей готель у базі 🙈 Натисни «📷 Фото готелю» в /help і вибери ще раз.',
  none: 'По цьому посту питань уже немає 🙌'
};
const k = r.route === 'answer' ? 'none' : r.route;
const kind = (k === 'help' || !T[k]) ? 'menu' : 'button';
return [{ json: { chat_id: r.chat_id, kind, text: T[k] || T.help, url: (k === 'none' && r.post_url) || r.mini_app_url, button: k === 'none' ? 'Повернутись у TravelLab' : 'Відкрити TravelLab' } }];`

// «Пост виклала?»: відповідь Іри на запит WF-050
const ppostReply = `const r = $('Code - Resolve').first().json;
const c = $json;
const ok = c.statusCode >= 200 && c.statusCode < 300 && Array.isArray(c.body) && c.body.length > 0;
const fail = !(c.statusCode >= 200 && c.statusCode < 300);
const t = '«' + r.pp.title + '»';
const text = fail ? 'Не вдалось позначити 🙈 Відкрий календар в апці й зроби це там.'
  : !ok ? 'Пост ' + t + ' уже оброблено раніше ✓'
  : r.pp.action === 'pub' ? 'Позначила ✅ ' + t + ' — викладено. Дякую!'
  : r.pp.action === 'tmr' ? 'Перенесла 📅 ' + t + ' на завтра, ' + r.pp.tmr + '.'
  : 'Добре ⏭ ' + t + ' не публікуємо.';
return [{ json: { chat_id: r.chat_id, kind: 'button', text, url: r.post_url || r.mini_app_url, button: 'Відкрити календар' } }];`

// «✅ Виклала»: позначка стала (рядок повернувся) або вже стояла раніше
const posted = `const r = $('Code - Resolve').first().json;
const c = $json;
const ok = c.statusCode >= 200 && c.statusCode < 300 && Array.isArray(c.body) && c.body.length > 0;
const fail = !ok && !(c.statusCode >= 200 && c.statusCode < 300);
const what = (r.video.format === 'reel' ? 'Рілс' : 'Сторіз') + ' «' + r.video.name + '»';
const text = fail ? 'Не вдалось позначити 🙈 Відкрий відео в апці й натисни «✅ Виклала» там.'
  : ok ? 'Позначила ✅ ' + what + ' — опубліковано. Дякую!' : what + ' уже позначено як опубліковане ✓';
return [{ json: { chat_id: r.chat_id, kind: 'button', text, url: r.video_url || r.mini_app_url, button: 'Відкрити відео' } }];`

const resolveText = `// Текст відповіді: розшифровка голосового або текст як є
const r = $('Code - Resolve').first().json;
let text = r.text || '';
if (r.file_id) { try { text = String($('OpenAI - Transcribe').first().json.text || '').trim(); } catch (e) { text = ''; } }
return [{ json: { ...r, answer_text: text } }];`

const PARSE_SYSTEM = [
  'Ти розбираєш відповідь Ірини (TravelLab, luxury travel) на питання агента для поста. Дано пронумеровані питання з id і її відповідь — часто це розшифровка голосового, можуть бути помилки розпізнавання.',
  'Для кожного питання випиши, що вона відповіла: її словами, коротко (1–2 речення), без вступів. Нічого не вигадуй і не додавай від себе.',
  'Ціни й дати — точно як сказала (число, валюта, місяць). Якщо на питання вона не відповіла або сказала «не знаю» — answer null.',
  'Одна відповідь може стосуватись кількох питань — тоді розклади по відповідних id.',
  'Відповідь — СТРОГО JSON без іншого тексту: {"answers": [{"id": "<id питання>", "answer": "текст" або null}]}',
].join('\n')

const parsePrompt = `const r = $json;
const user = 'ПИТАННЯ:\\n' + r.questions.map((q, i) => (i + 1) + '. [id: ' + q.id + '] ' + q.question).join('\\n') + '\\n\\nВІДПОВІДЬ ІРИНИ:\\n<<<\\n' + r.answer_text + '\\n>>>';
return [{ json: { ...r, systemPrompt: ${JSON.stringify(PARSE_SYSTEM)}, userPrompt: user } }];`

const parseAnswers = `// Відповідь моделі → які питання закрито
const r = $('Code - Resolve Text').first().json;
let out = null;
try {
  const j = $json;
  const message = Array.isArray(j.output) ? j.output[0] : j;
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  out = JSON.parse(raw);
} catch (e) { out = null; }
const ids = new Set(r.questions.map(q => q.id));
const got = [];
for (const a of (out && Array.isArray(out.answers) ? out.answers : [])) {
  const t = a && typeof a.answer === 'string' ? a.answer.replace(/\\s+/g, ' ').trim().slice(0, 1000) : '';
  if (a && ids.has(a.id) && t && !got.some(g => g.id === a.id)) got.push({ id: a.id, answer: t });
}
const remaining = r.questions.filter(q => !got.some(g => g.id === q.id));
return [{ json: { ...r, got, remaining, all_done: got.length > 0 && remaining.length === 0, heard: !!r.answer_text } }];`

const notHeard = `${esc}
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.post_url) + (r.heard ? 'Не розчув відповідей на ці питання 🙈' : 'Не вдалось розібрати голосове 🙈') + '\\n\\n' + list(r.questions) + '\\n\\nЗапиши ще раз у відповідь на це повідомлення, будь ласка.'
} }];`

const answerItems = `const r = $('Code - Parse Answers').first().json;
return r.got.map(g => ({ json: { id: g.id, answer: g.answer, supabase_url: r.supabase_url } }));`

const afterSave = `${esc}
// Після запису: всі відповіді → забрали пост у роботу → «Дякую! Записав… Дописую пост»; частина → дописати решту
const r = $('Code - Parse Answers').first().json;
const saved = $('HTTP - Save Answer').all().map(i => i.json).filter(j => j && j.statusCode >= 200 && j.statusCode < 300).length;
const qa = r.got.map(g => '• ' + esc(g.answer)).join('\\n');
if (!saved) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'Не вдалось записати відповідь 🙈 Спробуй ще раз або відповідай в апці.', url: r.post_url, button: 'Повернутись у TravelLab', claim: false } }];
if (r.remaining.length) return [{ json: { chat_id: r.chat_id, kind: 'force', claim: false,
  text: hidden(r.post_url) + 'Записав ✅\\n' + qa + '\\n\\nЛишилось:\\n' + list(r.remaining) + '\\n\\nДозапиши, будь ласка, у відповідь на це повідомлення.'
} }];
return [{ json: { chat_id: r.chat_id, kind: 'button', claim: true, text: 'Дякую! Записав:\\n' + qa + '\\n\\nДописую пост ✍️', url: r.post_url, button: 'Повернутись у TravelLab' } }];`

const runInput = `// Вхід для Data Answer (той самий, що з апки)
const r = $('Code - Parse Answers').first().json;
return [{ json: { content_plan_id: r.plan.id, expected_version_no: Number(r.plan.version_no || 0), author_tg_id: r.from_id, via: 'voice_bot', prev_status: r.plan.review_status } }];`

// ───── «🎙 Розповісти історію» ─────
const storyAsk = `${esc}
// /story: питання-підказка тижня + force_reply з прихованим маркером ?start=story (відповідь на нього = історія)
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.story_url) + '🎙 <b>Історія для постів</b>\\n\\nПідказка цього тижня:\\n<i>' + esc(r.hint) + '</i>\\n\\n'
    + 'Або будь-яка інша історія — твоя чи клієнтів. Запиши голосове на 1–3 хв у відповідь на це повідомлення (можна й текстом). '
    + 'Імена клієнтів не обовʼязково — я їх не пишу. Після запису обереш, коли пост: сьогодні, завтра чи в план тижня. Текст побачиш в апці до публікації.'
} }];`

const storyText = `// Текст історії: розшифровка голосового або текст як є
const r = $('Code - Resolve').first().json;
let text = r.text || '';
if (r.file_id) { try { text = String($('OpenAI - Transcribe Story').first().json.text || '').trim(); } catch (e) { text = ''; } }
text = text.replace(/^\\/story(@\\w+)?\\s*/i, '').trim();
const words = text ? text.split(/\\s+/).length : 0;
return [{ json: { ...r, story_raw: text, words, long_enough: words >= 12 } }];`

const STORY_SYSTEM = [
  'Ти готуєш голосову історію Ірини (TravelLab, luxury travel агентка) для черги постів. Дано розшифровку голосового — можуть бути помилки розпізнавання, слова-паразити, повтори — і список готелів бази.',
  'clean: та сама історія її словами, від першої особи, як вона розповіла. Прибери «ну», «ееее», «коротше», повтори й обірвані фрази, виправ очевидні помилки розпізнавання (назви готелів і місць — за списком). НЕ скорочуй суть, НЕ додавай подробиць, оцінок і висновків, яких вона не казала. Імена клієнтів заміни на «клієнти», «пара», «мама з донькою» тощо.',
  'title: 3–6 слів, про що історія (для звіту Владу).',
  'hotel_id: id готелю зі списку, якщо історія саме про нього; інакше null. destination: країна або острів, якщо названо; інакше null.',
  'is_story: false, якщо це не історія з поїздок/роботи (тест мікрофона, випадкове повідомлення, питання до бота).',
  'Відповідь — СТРОГО JSON без іншого тексту: {"clean": "...", "title": "...", "hotel_id": "HTL-…" або null, "destination": "..." або null, "is_story": true}',
].join('\n')

const storyPrompt = `const r = $json;
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && j.hotel_id); } catch (e) { return []; } };
const hotels = all('Supabase - Get Hotels').map(h => h.hotel_id + ' — ' + (h.name || '') + (h.country ? ' (' + h.country + ')' : '')).join('\\n');
const user = 'ГОТЕЛІ БАЗИ:\\n' + (hotels || '—') + '\\n\\nРОЗШИФРОВКА ІСТОРІЇ ІРИНИ:\\n<<<\\n' + r.story_raw + '\\n>>>';
return [{ json: { ...r, systemPrompt: ${JSON.stringify(STORY_SYSTEM)}, userPrompt: user } }];`

const storyRow = `// Відповідь моделі → рядок story_queue. Модель не відповіла — пишемо сиру розшифровку (історія не губиться)
const r = $('Code - Story Text').first().json;
let o = null;
try {
  const j = $json;
  const message = Array.isArray(j.output) ? j.output[0] : j;
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  o = JSON.parse(raw);
} catch (e) { o = null; }
const ids = new Set($('Supabase - Get Hotels').all().map(i => i.json.hotel_id).filter(Boolean));
const clean = o && typeof o.clean === 'string' && o.clean.trim().length > 20 ? o.clean.trim() : r.story_raw;
const row = {
  pillar: 'personal_experience',
  hotel_id: o && ids.has(o.hotel_id) ? o.hotel_id : null,
  destination: o && typeof o.destination === 'string' && o.destination.trim() ? o.destination.trim().slice(0, 120) : null,
  transcript_raw: r.story_raw,
  transcript_clean: clean,
  status: 'new',
};
const title = o && typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : clean.split(/\\s+/).slice(0, 6).join(' ') + '…';
return [{ json: { ...r, row, title, is_story: !(o && o.is_story === false) } }];`

const storySaved = `${esc}
const r = $('Code - Story Row').first().json;
const res = $json;
const ok = res.statusCode >= 200 && res.statusCode < 300;
if (!ok) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'Не вдалось записати історію 🙈 Перешли це голосове ще раз трохи згодом — або Владу.', url: r.mini_app_url, button: 'Відкрити TravelLab' } }];
const head = 'Дякую! Записав історію ✅\\n«' + r.title + '»'
  + (r.is_story ? '' : '\\n\\n(Схоже, це не історія з поїздок — якщо випадково, скажи Владу, він прибере.)');
// id історії → кнопки «коли публікувати»; без id (Supabase не повернув рядок) — як раніше, у план тижня
const id = Array.isArray(res.body) && res.body[0] ? res.body[0].id : null;
if (!id) return [{ json: { chat_id: r.chat_id, kind: 'button',
  text: head + '\\n\\nВона піде в найближчий суботній пост — план тижня складаю в неділю ввечері. Текст побачиш в апці до публікації.',
  url: r.mini_app_url, button: 'Відкрити TravelLab' } }];
return [{ json: { chat_id: r.chat_id, kind: 'story_choice', story_id: id,
  text: head + '\\n\\nКоли робимо пост?\\n🔥 Сьогодні або 📅 Завтра — напишу одразу і покладу в апку.\\n🗓 У план тижня — поставлю, коли складатиму план у неділю.' } }];`

// ───── «Коли публікувати» історію (16.11) ─────
const storyWhen = `// Сьогодні/Завтра → генеруємо; «У план тижня» або історії вже нема в черзі — лише відповідь
const r = $json;
const st = r.story;
const reply = (text) => [{ json: { chat_id: r.chat_id, kind: 'button', go: false, text, url: r.mini_app_url, button: 'Відкрити TravelLab' } }];
if (!st) return reply('Не знайшов цю історію 🙈 Запиши її ще раз — /story.');
if (st.status !== 'new') return reply('Ця історія вже в плані 🙌 Глянь в апці.');
if (r.when === 'week') return reply('Ок 🗓 Історія чекає в черзі — поставлю її, коли складатиму план тижня (неділя ввечері). Текст побачиш в апці до публікації.');
const day = r.when === 'tmr' ? 'завтра' : 'сьогодні';
return [{ json: { ...r, go: true, day_word: day, wait_text: '✍️ Пишу пост з твоєю історією на ' + day + ' — це 1–2 хв. Напишу, щойно буде готовий.' } }];`

const storyGenInput = `// Вхід Post Generator — як у Buffer Filler (mode initial), але note порожній: без теми/аудиторії тижня
${RULES_JS}
const all = (x) => { try { return $(x).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const r = $('Code - Story When').first().json;
const plan = $('HTTP - Insert Story Plan').first().json.body[0];
const hotels = Object.fromEntries(all('Supabase - Get Hotels').map(h => [h.hotel_id, h]));
const CUTOVER = new Date('2026-09-19T12:00:00Z');
const legacy = all('Supabase - Get Approved Posts').filter(p => p.content && p.created_at && new Date(p.created_at) >= CUTOVER);
const goldenPlans = Object.fromEntries(all('Supabase - Get Golden Plans').map(p => [p.id, p]));
const golden = all('Supabase - Get Golden Versions').filter(v => v.text).sort((a, b) => String(b.golden_at).localeCompare(String(a.golden_at)))
  .filter(v => (goldenPlans[v.content_plan_id] || {}).platform === 'telegram').slice(0, 3).map(v => ({ text: v.text }));
const rules = pickIraRules(all('Supabase - Get Rules'), plan);
return [{ json: applyIraRules({
  mode: 'initial',
  slot: { day: plan.day, platform: plan.platform, slot_type: plan.slot_type, pillar: plan.pillar, note: '' },
  week_parity: DateTime.fromISO(plan.scheduled_for).weekNumber % 2 === 0 ? 'even' : 'odd',
  tour: null, hotel: plan.hotel_id ? hotels[plan.hotel_id] || null : null, story: r.story,
  fewshot: [...golden, ...legacy],
  passthrough: { content_plan_id: plan.id }
}, rules) }];`

const storyGenParse = `// Відповідь генератора → що писати у версію (як Buffer Filler)
const g = $json || {};
const plan = $('HTTP - Insert Story Plan').first().json.body[0];
const ok = !!(g.status && g.status !== 'failed' && g.text);
const lintErr = g.lint_errors || [];
return [{ json: {
  _ok: ok,
  _error: ok ? '' : String(g.error || g.status || 'генератор не повернув текст').slice(0, 300),
  plan_id: plan.id,
  photo_count: plan.hotel_id ? 1 : 0,
  rpc: ok ? {
    p_content_plan_id: plan.id,
    p_text: g.text,
    p_trigger: 'initial',
    p_expected_version_no: 0,
    p_hooks: Array.isArray(g.hooks) && g.hooks.length ? g.hooks : null,
    p_form: g.form || null,
    p_key_idea: g.key_idea || null,
    p_model: 'gpt-4.1',
    p_prompt_version: 'PRMPT-011 v5 · story_bot',
    p_lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    p_missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : [],
    p_review_status: 'ready_for_review'
  } : null
} }];`

const storyResult = `// Підсумок: пост у апці → Ірі «готово» з кнопкою на пост; ні → відкат + Владу
const r = $('Code - Story When').first().json;
const prev = $prevNode.name;
let planId = null;
try { const b = $('HTTP - Insert Story Plan').first().json.body; planId = Array.isArray(b) && b[0] ? b[0].id : null; } catch (e) { planId = null; }
const msg = (j) => String((j.body && (j.body.message || j.body.code)) || (j.error && j.error.message) || ('HTTP ' + j.statusCode)).slice(0, 300);
let ok = false, note = '';
if (prev === 'IF - Story Plan Created?') note = 'слот не створився: ' + msg($json);
else if (prev === 'IF - Story Generated?') note = $json._error || 'генератор не повернув текст';
else { ok = $json.statusCode >= 200 && $json.statusCode < 300; if (!ok) note = 'версія не записалась: ' + msg($json); }
const base = r.mini_app_url;
const postUrl = planId && base ? base + '/?startapp=post_' + planId : base;
if (ok) return [{ json: { ok: true, chat_id: r.chat_id, kind: 'button', url: postUrl, button: '👀 Глянути пост',
  text: 'Готово ✨ Пост з твоєю історією на ' + r.day_word + ', ' + r.date_label + ' о ' + r.time + '.\\n\\nГлянь і затверди в апці — дату й час можна змінити там же.' } }];
return [{ json: { ok: false, plan_id: planId, story_id: r.story.id, supabase_url: r.supabase_url,
  admin_chat_id: r.admin_chat_id, admin_text: '⚠️ Історія «' + String(r.story.transcript_clean || '').slice(0, 60) + '…» → пост на ' + r.date_label + ' не вийшов: ' + note,
  chat_id: r.chat_id, kind: 'button', url: postUrl, button: 'Відкрити TravelLab',
  text: planId ? 'Не вийшло написати пост 🙈 Історія стоїть у плані на ' + r.date_label + ' — Влад подивиться.'
    : 'Не вийшло поставити історію в план 🙈 Вона збережена — натисни кнопку ще раз трохи згодом.' } }];`

const storyShort = `${esc}
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.story_url) + (r.story_raw ? 'Здається, історія обірвалась — розчув лише: «' + esc(r.story_raw) + '» 🙈' : 'Не вдалось розібрати голосове 🙈')
    + '\\n\\nЗапиши ще раз у відповідь на це повідомлення, будь ласка — хоча б кілька речень.'
} }];`

// ───── «🎙 Голос до відео» (сет 6) ─────
const voAsk = `${esc}
// /start vo_<id>: просимо голосове до цього відео (force_reply + прихований маркер — відповідь знає, до якого відео)
const r = $json;
const what = r.video.format === 'reel' ? 'рілсу' : 'сторіз';
return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.vo_url) + '🎙 <b>Голос до ' + what + ' «' + esc(r.video.name) + '»</b>\\n\\n'
    + 'Запиши голосове на 15–30 с у відповідь на це повідомлення — своїми словами, ніби розповідаєш подрузі, що на відео. '
    + 'Не страшно, якщо будуть паузи чи «е-е» — я їх приберу.\\n\\n'
    + 'Далі сам: почищу звук, зроблю субтитри (виправиш в апці), підгоню кадри під голос, музика буде тихо на фоні.'
    + (r.video.has_voice ? '\\n\\nНовий голос замінить попередній.' : '')
} }];`

const voCheck = `${esc}
// Голосове до відео: лише голос / аудіо, 3–45 с → заявка воркеру; інакше — пояснюємо й чекаємо ще раз
const r = $json;
const a = r.audio;
let err = '';
if (!a) err = 'Потрібне саме голосове 🎙 — затисни мікрофон і запиши у відповідь на це повідомлення.';
else if (a.dur && a.dur < 3) err = 'Дуже коротко 🙈 Запиши 15–30 с, будь ласка.';
else if (a.dur > 45) err = 'Задовге (' + Math.round(a.dur) + ' с) — для рілсу треба до 45 с, краще 15–30. Запиши коротше, будь ласка.';
const now = new Date().toISOString();
const row = { remount: { kind: 'voice', file_id: a ? a.file_id : null, tg_dur: a ? a.dur : null, state: 'queued', at: now, by: Number(r.from_id) },
  status: 'ready_for_review', approved_at: null, approved_by: null,
  final_path: null, cover_path: null, rendered_at: null, render_error: null, tg_file_id: null, sent_at: null, sent_to: null, updated_at: now };
return [{ json: { ...r, ok: !err, err_text: err ? hidden(r.vo_url) + err : '', row } }];`

const voSaved = `// Заявку поставили → «монтую», кнопка прямо у відео; відео вже монтується → попросити пізніше
const r = $('Code - Video Voice Check').first().json;
const res = $json;
const ok = res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.body) && res.body.length > 0;
return [{ json: { chat_id: r.chat_id, kind: 'button', url: r.video_url, button: 'Відкрити відео',
  text: ok ? 'Отримав голос ✅ Монтую 1–2 хв: чищу звук, роблю субтитри, підганяю кадри під голос. Відкрий відео — побачиш, коли буде готово, і зможеш виправити слова в субтитрах.'
    : 'Зараз це відео саме монтується ⏳ Надішли голосове ще раз за хвилинку — у відповідь на моє повідомлення вище.' } }];`

// ───── «🎬 Відео» ─────
const INBOX_URL = 'https://drive.google.com/drive/folders/' + CFG.inboxId
const videoAsk = `// /video: куди кидати відео і що написати потім
const r = $json;
return [{ json: { chat_id: r.chat_id, kind: 'link', url: ${JSON.stringify(INBOX_URL)}, button: '📂 Відкрити папку для відео',
  text: '🎬 Відео для рілс і сторіз\\n\\n'
    + 'Закинь відео в папку «00_Inbox» (кнопка нижче):\\n'
    + '• телефон: Google Диск → «+» → Завантажити → Фото й відео. Не закривай Диск, поки не завантажиться;\\n'
    + '• компʼютер: перетягни файли або цілу папку.\\n\\n'
    + 'Можна підпапкою з назвою готелю чи острова — так я швидше впізнаю місце. '
    + 'Не пересилай відео через Telegram/WhatsApp/Viber: вони стискають якість і стирають, де знято.\\n\\n'
    + 'Коли все завантажиться — повернись сюди й натисни «✅ Відео готово».'
} }];`

// Inbox → підпапки: другий запит бере і сам Inbox, і всі його підпапки (один рівень)
const videoQuery = `const files = Array.isArray($json.files) ? $json.files : [];
const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
const ids = [${JSON.stringify(CFG.inboxId)}, ...folders.map(f => f.id)];
return [{ json: { q: '(' + ids.map(id => "'" + id + "' in parents").join(' or ') + ') and trashed=false', folders: folders.map(f => ({ id: f.id, name: f.name })), list_error: $json.error ? String($json.error.message || $json.error).slice(0, 200) : '' } }];`

const videoSummary = `${esc}
// Підсумок Inbox: скільки відео, де, скільки місця; Владу — сигнал «можна розбирати» (HTML: назви папок екрануємо)
const r = $('Code - Resolve').first().json;
const q = $('Code - Video Query').first().json;
const files = (Array.isArray($json.files) ? $json.files : []).filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
const err = q.list_error || ($json.error ? String($json.error.message || $json.error).slice(0, 200) : '');
const names = Object.fromEntries(q.folders.map(f => [f.id, f.name]));
const videos = files.filter(f => String(f.mimeType || '').startsWith('video/'));
const photos = files.filter(f => String(f.mimeType || '').startsWith('image/'));
const other = files.length - videos.length - photos.length;
const gb = videos.reduce((s, f) => s + Number(f.size || 0), 0) / 1e9;
const by = {};
for (const f of videos) { const k = names[(f.parents || [])[0]] || ''; by[k] = (by[k] || 0) + 1; }
const lines = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, c]) => '• ' + (k ? '«' + esc(k) + '»' : 'без папки') + ' — ' + c);
const size = gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' ГБ' : Math.round(gb * 1000) + ' МБ';
const url = ${JSON.stringify(INBOX_URL)};
let text, admin = '';
if (err) text = 'Не вдалось відкрити папку з відео 🙈 Я передав Владу, він подивиться.';
else if (!videos.length) text = 'У папці поки немає відео 🤔\\n\\nЯкщо завантажувала з телефона — перевір, що завантаження закінчилось (Диск має бути відкритий до кінця). Потім знову натисни «✅ Відео готово».';
else text = 'Отримав ' + videos.length + ' відео (' + size + ') ✅\\n' + lines.join('\\n')
  + (photos.length ? '\\n\\nФото в цій папці (' + photos.length + ') не беру — фото готелю чи острова завантажуй через кнопки «📷 Фото готелю» / «🏝 Фото острова» в /help.' : '')
  + '\\n\\nТепер я їх розберу: де знято, який готель чи острів, найкращі моменти. Перший рілс покаже Влад.';
if (err) admin = '⚠️ Іра написала «відео готово», але Inbox не відкрився: ' + esc(err);
else if (videos.length) admin = '🎬 Іра закинула ' + videos.length + ' відео (' + size + ') у 00_Inbox:\\n' + lines.join('\\n')
  + (photos.length ? '\\n+ фото: ' + photos.length : '') + (other > 0 ? '\\n+ інші файли: ' + other : '') + '\\n\\nМожна запускати розбір (Reels_Test_Plan §3).';
return [{ json: { chat_id: r.chat_id, kind: 'link', text, url, button: '📂 Відкрити папку для відео',
  admin_chat_id: r.admin_chat_id, admin_text: admin, notify_admin: !!admin && !!r.admin_chat_id && r.admin_chat_id !== r.chat_id } }];`

// ───── «📷 Фото готелю» / «🏝 Фото острова» / «🏨 Розповісти про готель» (сет 1) ─────
// номер зі списку або назва (точна, або єдиний збіг від 4 літер)
const PICK_JS = `const norm = (s) => String(s || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
const pick = (opts, txt) => {
  const t = String(txt || '').trim();
  if (/^\\d{1,3}$/.test(t)) { const k = parseInt(t, 10); return k >= 1 && k <= opts.length ? opts[k - 1] : null; }
  const q = norm(t);
  if (!q) return null;
  const exact = opts.find(x => norm(x.name) === q);
  if (exact) return exact;
  if (q.length < 4) return null;
  const c = opts.filter(x => { const v = norm(x.name); return v.includes(q) || q.includes(v); });
  return c.length === 1 ? c[0] : null;
};
const numbered = (xs) => xs.map((x, i) => (i + 1) + '. ' + esc(x.name)).join('\\n');`

const photoStep = `${esc}
${PICK_JS}
// /photo: список готелів з номерами (force_reply + маркер ?start=photo); відповідь → /upload <точна назва> у Media Intake
const r = $json;
const opts = r.hotels || [];
if (!opts.length) return [{ json: { chat_id: r.chat_id, kind: 'button', text: 'У базі ще нема готелів 🙈 Скажи Владу.', url: r.mini_app_url, button: 'Відкрити TravelLab' } }];
if (r.route === 'photo_ask') return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.photo_url) + '📷 <b>Фото готелю</b>\\n\\nДля якого готелю? Напиши номер у відповідь на це повідомлення:\\n\\n' + numbered(opts)
    + '\\n\\nНового готелю в списку нема? Натисни «➕ Новий готель» у /help.' } }];
const h = pick(opts, r.text);
if (!h) return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.photo_url) + 'Не знайшов «' + esc(r.text) + '» 🙈 Напиши номер зі списку у відповідь на це повідомлення:\\n\\n' + numbered(opts) } }];
return [{ json: { ...r, media_text: '/upload ' + h.name } }];`

// «➕ Новий готель» (сет 2): назва → (схожі в базі?) → країна → Media Intake `/newhotel Назва | Країна` (HTL-XXX + папка Drive + кнопки)
const newHotelStep = `${esc}
${PICK_JS}
const r = $json;
const hotels = r.hotels || [];
const norm2 = (s) => String(s || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
const mark = (k, v) => hidden(r.tg_start + k + (v === undefined ? '' : encodeURIComponent(v)));
const countries = [...new Set(hotels.map(h => String(h.country || '').trim()).filter(c => c && !/^уточнити$/i.test(c)))]
  .sort((a, b) => a.localeCompare(b, 'uk')).map(name => ({ name }));
const similarOf = (name) => {
  const q = norm2(name);
  const stop = new Set(['resort', 'resorts', 'hotel', 'hotels', 'spa', 'beach']);
  const tokens = String(name).toLowerCase().split(/[^\\p{L}\\p{N}]+/u).filter(t => t.length >= 4 && !stop.has(t));
  return hotels.filter(h => { const n = norm2(h.name); return n === q || tokens.some(t => n.includes(t)); }).slice(0, 6);
};
const askCountry = (name, lead) => ({ chat_id: r.chat_id, kind: 'force',
  text: mark('nhc_', name) + (lead || '') + '🌍 <b>' + esc(name) + '</b>\\n\\nУ якій країні? Напиши номер у відповідь на це повідомлення — або назву нової країни:\\n\\n' + (countries.length ? numbered(countries) : '(ще нема жодної — напиши назву)') });
const askName = (lead) => ({ chat_id: r.chat_id, kind: 'force',
  text: mark('newhotel') + (lead || '') + '➕ <b>Новий готель</b>\\n\\nЯк він називається? Напиши назву у відповідь на це повідомлення (як на сайті готелю, наприклад: Ikos Aria).' });
const out = (o) => [{ json: o }];
const t = String(r.text || '').trim();
if (!r.how || r.how === 'none') return out(askName(''));
if (r.how === 'nh') {
  const name = t.replace(/[|\\n]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 80);
  if (name.length < 3) return out(askName('Не зрозуміла назву 🙈 '));
  const exact = hotels.find(h => norm2(h.name) === norm2(name));
  if (exact) return out({ ...r, media_text: '/upload ' + exact.name });
  const sim = similarOf(name);
  if (sim.length) return out({ chat_id: r.chat_id, kind: 'force',
    text: mark('nhd_', name) + '🤔 Схожі готелі вже є в базі:\\n\\n' + numbered(sim) + '\\n\\nЦе один із них? Напиши його номер. Якщо «' + esc(name) + '» — зовсім новий, напиши слово <b>новий</b>.' });
  return out(askCountry(name, ''));
}
const name = String(r.nh_name || '').trim();
if (!name) return out(askName(''));
if (r.how === 'nhd') {
  if (/^нов/i.test(t)) return out(askCountry(name, ''));
  const sim = similarOf(name);
  const h = pick(sim, t);
  if (h) return out({ ...r, media_text: '/upload ' + h.name });
  return out({ chat_id: r.chat_id, kind: 'force',
    text: mark('nhd_', name) + 'Не зрозуміла 🙈 Напиши номер зі списку або слово <b>новий</b>:\\n\\n' + numbered(sim) });
}
// nhc: країна — номер зі списку або нова назва
if (/^\\d{1,3}$/.test(t) && !pick(countries, t)) return out(askCountry(name, 'Нема країни з номером ' + esc(t) + ' 🙈 '));
const country = (pick(countries, t) || { name: t.replace(/[|\\n]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 40) }).name;
if (country.length < 3) return out(askCountry(name, 'Не зрозуміла 🙈 '));
return out({ ...r, media_text: '/newhotel ' + name + ' | ' + country });`

const islandStep = `${esc}
${PICK_JS}
// /island: острови = підпапки Destinations на Диску Іри (Costa_Rica → «Costa Rica»; Media Intake назад робить ту саму папку).
// Відповідь: номер / назва наявного острова, або нова назва → нова папка
const r = $('Code - Resolve').first().json;
const err = $json.error ? String($json.error.message || $json.error).slice(0, 200) : '';
const opts = (Array.isArray($json.files) ? $json.files : [])
  .map(f => ({ name: String(f.name || '').replace(/_+/g, ' ').trim() }))
  .filter(x => x.name && !/^qa\\s*test/i.test(x.name))
  .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
const intro = '🏝 <b>Фото острова</b>\\n\\nФото місця без привʼязки до готелю: пляжі, вид, атмосфера. ';
if (r.route === 'island_ask') return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.island_url) + intro + (opts.length
    ? 'Напиши номер острова у відповідь на це повідомлення — або назву нового:\\n\\n' + numbered(opts)
    : (err ? 'Не вдалось відкрити список островів 🙈 ' : '') + 'Напиши назву острова у відповідь на це повідомлення.') } }];
const t = String(r.text || '').trim();
if (/^\\d{1,3}$/.test(t) && !pick(opts, t)) return [{ json: { chat_id: r.chat_id, kind: 'force',
  text: hidden(r.island_url) + 'Нема острова з номером ' + esc(t) + ' 🙈 Напиши номер зі списку або назву нового:\\n\\n' + numbered(opts) } }];
const name = (pick(opts, t) || { name: t.replace(/\\s+/g, ' ').slice(0, 60) }).name;
return [{ json: { ...r, media_text: '/island ' + name } }];`

// вхід Media Intake (Ira bot) — той самий вигляд, що Telegram-апдейт для Route Message; «готово» → спершу «⏳ описую»
const mediaInput = `const r = $json;
const ready = /^(острів\\s+)?готово/i.test(r.media_text);
return [{ json: { message: { chat: { id: Number(r.chat_id) }, text: r.media_text }, chat_id: r.chat_id,
  ack: ready ? '⏳ Дивлюсь папку й описую нові фото — це 1–3 хв. Напишу, коли закінчу.' : '' } }];`

// вхід Hotel Voice Intake (Ira bot) — як від WF-022: branch voice_start / voice_cancel / voice_session
const hvInput = `const r = $json;
return [{ json: { branch: r.hv_branch || 'voice_session', chat_id: r.chat_id, text: r.hv_text || r.text || '', voice_file_id: r.file_id || null } }];`

const driveList = (name, x, q, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, x, {
  url: 'https://www.googleapis.com/drive/v3/files',
  authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
  sendQuery: true,
  queryParameters: { parameters: [
    { name: 'q', value: q },
    { name: 'fields', value: 'files(id,name,mimeType,size,parents)' },
    { name: 'pageSize', value: '1000' },
  ] },
  options: {},
}, { credentials: { googleDriveOAuth2Api: CFG.drive }, onError: 'continueRegularOutput', executeOnce: true, ...extra })

const Y = 260
const coreNodes = [
  node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, 0, { inputSource: 'passthrough' }),
  node('Webhook - Test Update', 'n8n-nodes-base.webhook', 2, 0, { httpMethod: 'POST', path: 'travellab-bot-update-test', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
    { webhookId: '6b2f0d8e-91a4-4c7b-a3e5-tl-bot-update-test', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 200 }),
  node('Code - Normalize', 'n8n-nodes-base.code', 2, 220, { jsCode: normalize }),
  ifNode('IF - Anything?', 440, "={{ $json.route !== 'ignore' }}"),
  getAll('Supabase - Get Settings', 660, 'settings'),
  getAll('Supabase - Get Plans', 880, 'content_plan',
    "={{ $('Code - Normalize').first().json.plan_id ? 'id=eq.' + $('Code - Normalize').first().json.plan_id : 'review_status=eq.needs_data' }}"),
  getAll('Supabase - Get Open Requests', 1100, 'data_requests', 'status=eq.open', { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Hotels', 1320, 'hotels'),
  getAll('Supabase - Get Tours', 1540, 'tours'),
  getAll('Supabase - Get Audiences', 1650, 'audiences', null, { onError: 'continueRegularOutput', y: 200 }),
  // голос до відео (сет 6): чернетка за id з vo_<id>; інакше — запит-заглушка (порожньо)
  getAll('Supabase - Get Video Draft', 1700, 'video_drafts',
    "={{ 'id=eq.' + ($('Code - Normalize').first().json.video_id || '00000000-0000-0000-0000-000000000000') }}", { onError: 'continueRegularOutput', y: -200 }),
  // «коли публікувати» історію: рядок story_queue за id з кнопки; інакше — заглушка (порожньо)
  getAll('Supabase - Get Story', 1730, 'story_queue',
    "={{ 'id=eq.' + ($('Code - Normalize').first().json.story_id || '00000000-0000-0000-0000-000000000000') }}", { onError: 'continueRegularOutput', y: -400 }),
  // розмова про готель (Hotel Voice Intake): сесії цього чату, відкриту бере Resolve (neq у фільтрі не покладаємось — ERR-034)
  getAll('Supabase - Get Intake Session', 1745, 'intake_sessions',
    "={{ 'chat_id=eq.' + ($('Code - Normalize').first().json.chat_id || '0') }}", { onError: 'continueRegularOutput', y: -600 }),
  node('Code - Resolve', 'n8n-nodes-base.code', 2, 1760, { jsCode: resolve }, { executeOnce: true }),
  node('Switch - Route', 'n8n-nodes-base.switch', 3.2, 1980, {
    rules: { values: ['ask', 'answer', 'help', 'unresolved', 'gone', 'story_ask', 'story', 'video_ask', 'video_ready', 'vo_ask', 'vo', 'vo_gone', 'vpub', 'story_when',
      'photo_ask', 'photo_pick', 'island_ask', 'island_pick', 'media', 'hv', 'photo_gone', 'ppost', 'nh'].map((k) => ({
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, combinator: 'and',
        conditions: [{ id: 'r-' + k, leftValue: '={{ $json.route }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }] },
      renameOutput: true, outputKey: k,
    })) },
    options: {},
  }),
  node('Code - Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: ask }, { y: -2 * Y }),
  node('Code - Simple Reply', 'n8n-nodes-base.code', 2, 2200, { jsCode: simple }, { y: 2 * Y }),
  ifNode('IF - Has Questions?', 2200, '={{ $json.questions.length > 0 }}'),
  ifNode('IF - Voice?', 2420, '={{ !!$json.file_id }}'),
  node('Telegram - Get Voice File', 'n8n-nodes-base.telegram', 1.2, 2640, { resource: 'file', operation: 'get', fileId: '={{ $json.file_id }}', download: true },
    { ...tgc, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('OpenAI - Transcribe', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2860, { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', options: { language: 'uk' } },
    { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('Code - Resolve Text', 'n8n-nodes-base.code', 2, 3080, { jsCode: resolveText }, { executeOnce: true }),
  ifNode('IF - Got Text?', 3300, '={{ !!$json.answer_text }}'),
  node('Code - Parse Prompt', 'n8n-nodes-base.code', 2, 3520, { jsCode: parsePrompt }),
  node('OpenAI - Parse Answers', '@n8n/n8n-nodes-langchain.openAi', 2.3, 3740, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput' }),
  node('Code - Parse Answers', 'n8n-nodes-base.code', 2, 3960, { jsCode: parseAnswers }, { executeOnce: true }),
  ifNode('IF - Any Answer?', 4180, '={{ $json.got.length > 0 }}'),
  node('Code - Not Heard', 'n8n-nodes-base.code', 2, 4400, { jsCode: notHeard }, { executeOnce: true, y: Y }),
  node('Code - Answer Items', 'n8n-nodes-base.code', 2, 4400, { jsCode: answerItems }, { executeOnce: true }),
  rest('HTTP - Save Answer', 4620, 'PATCH', '={{ $json.supabase_url }}/rest/v1/data_requests?id=eq.{{ $json.id }}&status=eq.open',
    "={{ JSON.stringify({ answer: $json.answer, status: 'answered', answered_via: 'voice_bot', answered_at: $now.toISO() }) }}", { prefer: 'return=representation' }),
  node('Code - After Save', 'n8n-nodes-base.code', 2, 4840, { jsCode: afterSave }, { executeOnce: true }),
  ifNode('IF - Claim?', 5060, '={{ $json.claim }}'),
  // «забрати» пост у роботу лише якщо його ніхто не змінив (статус і версія ті самі)
  rest('HTTP - Claim Plan', 5280, 'PATCH',
    "={{ $('Code - Parse Answers').first().json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $('Code - Parse Answers').first().json.plan.id }}&version_no=eq.{{ $('Code - Parse Answers').first().json.plan.version_no || 0 }}&review_status=in.(needs_data,ready_for_review,changes_requested)&published_at=is.null",
    "={{ JSON.stringify({ review_status: 'regenerating', review_note: null, updated_at: $now.toISO() }) }}", { prefer: 'return=representation', y: -Y }),
  node('Code - Claimed', 'n8n-nodes-base.code', 2, 5500, {
    jsCode: `const c = $json;\nconst ok = c.statusCode >= 200 && c.statusCode < 300 && Array.isArray(c.body) && c.body.length > 0;\nconst r = $('Code - After Save').first().json;\nreturn [{ json: { ...r, run: ok, text: ok ? r.text : r.text.replace('Дописую пост ✍️', 'Пост допишу трохи згодом.') } }];`,
  }, { executeOnce: true, y: -Y }),
  // спільна відповідь: force_reply (питання) або кнопка web_app
  node('Code - Reply', 'n8n-nodes-base.code', 2, 5720, { jsCode: `return [{ json: { run: false, ...$input.first().json } }];` }, { executeOnce: true }),
  ifNode('IF - Force Reply?', 5940, "={{ $json.kind === 'force' }}"),
  node('Telegram - Ask (force reply)', 'n8n-nodes-base.telegram', 1.2, 6160, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'forceReply', forceReply: { force_reply: true },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: -Y / 2 }),
  node('Telegram - Reply (button)', 'n8n-nodes-base.telegram', 1.2, 6160, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false, disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y / 2 }),
  ifNode('IF - Run Data Answer?', 6380, "={{ $('Code - Reply').first().json.run === true }}"),
  node('Code - Data Answer Input', 'n8n-nodes-base.code', 2, 6600, { jsCode: runInput }, { executeOnce: true }),
  // «Розповісти історію» — окремий ряд нижче
  node('Code - Story Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: storyAsk }, { executeOnce: true, y: 4 * Y }),
  ifNode('IF - Story Voice?', 2200, '={{ !!$json.file_id }}', { y: 5 * Y }),
  node('Telegram - Get Story File', 'n8n-nodes-base.telegram', 1.2, 2420, { resource: 'file', operation: 'get', fileId: '={{ $json.file_id }}', download: true },
    { ...tgc, onError: 'continueRegularOutput', y: 5 * Y }),
  node('OpenAI - Transcribe Story', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2640, { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', options: { language: 'uk' } },
    { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: 5 * Y }),
  node('Code - Story Text', 'n8n-nodes-base.code', 2, 2860, { jsCode: storyText }, { executeOnce: true, y: 5 * Y }),
  ifNode('IF - Story Long Enough?', 3080, '={{ $json.long_enough }}', { y: 5 * Y }),
  node('Code - Story Too Short', 'n8n-nodes-base.code', 2, 3300, { jsCode: storyShort }, { executeOnce: true, y: 6 * Y }),
  node('Code - Story Prompt', 'n8n-nodes-base.code', 2, 3300, { jsCode: storyPrompt }, { executeOnce: true, y: 5 * Y }),
  node('OpenAI - Clean Story', '@n8n/n8n-nodes-langchain.openAi', 2.3, 3520, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: 5 * Y }),
  node('Code - Story Row', 'n8n-nodes-base.code', 2, 3740, { jsCode: storyRow }, { executeOnce: true, y: 5 * Y }),
  rest('HTTP - Insert Story', 3960, 'POST', "={{ $json.supabase_url }}/rest/v1/story_queue", '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 5 * Y }),
  node('Code - Story Saved', 'n8n-nodes-base.code', 2, 4180, { jsCode: storySaved }, { executeOnce: true, y: 5 * Y }),
  // «🎬 Відео» — ряд під історіями
  node('Code - Video Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: videoAsk }, { executeOnce: true, y: 7 * Y }),
  driveList('HTTP - List Inbox', 2200, "'" + CFG.inboxId + "' in parents and trashed=false", { y: 8 * Y }),
  node('Code - Video Query', 'n8n-nodes-base.code', 2, 2420, { jsCode: videoQuery }, { executeOnce: true, y: 8 * Y }),
  driveList('HTTP - List Inbox Files', 2640, '={{ $json.q }}', { y: 8 * Y }),
  node('Code - Video Summary', 'n8n-nodes-base.code', 2, 2860, { jsCode: videoSummary }, { executeOnce: true, y: 8 * Y }),
  ifNode('IF - Notify Admin?', 3080, '={{ $json.notify_admin }}', { y: 8 * Y }),
  node('Telegram - Notify Admin', 'n8n-nodes-base.telegram', 1.2, 3300, {
    chatId: '={{ $json.admin_chat_id }}', text: '={{ $json.admin_text }}',
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: 8 * Y }),
  node('Code - Video Reply', 'n8n-nodes-base.code', 2, 3520, { jsCode: `return [{ json: $('Code - Video Summary').first().json }];` }, { executeOnce: true, y: 8 * Y }),
  // «🎙 Голос до відео» — ряд під «Відео»
  node('Code - Video Voice Ask', 'n8n-nodes-base.code', 2, 2200, { jsCode: voAsk }, { executeOnce: true, y: 10 * Y }),
  node('Code - Video Voice Check', 'n8n-nodes-base.code', 2, 2200, { jsCode: voCheck }, { executeOnce: true, y: 11 * Y }),
  ifNode('IF - Voice OK?', 2420, '={{ $json.ok }}', { y: 11 * Y }),
  node('Code - Video Voice Retry', 'n8n-nodes-base.code', 2, 2640, {
    jsCode: `const r = $json;\nreturn [{ json: { chat_id: r.chat_id, kind: 'force', text: r.err_text } }];`,
  }, { executeOnce: true, y: 12 * Y }),
  // заявка лише якщо відео зараз не монтується (як IDLE у server/video.ts) і не «не публікувати»
  rest('HTTP - Queue Voice', 2640, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/video_drafts?id=eq.{{ $json.video.id }}&status=neq.skipped&or=(remount.is.null,remount->>state.in.(done,error))",
    '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 11 * Y }),
  node('Code - Video Voice Saved', 'n8n-nodes-base.code', 2, 2860, { jsCode: voSaved }, { executeOnce: true, y: 11 * Y }),
  // «✅ Виклала» — ряд під «Голос до відео»; позначаємо лише якщо ще не опубліковано
  rest('HTTP - Mark Posted', 2200, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/video_drafts?id=eq.{{ $json.video.id }}&published_at=is.null&status=eq.approved",
    '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 13 * Y }),
  node('Code - Posted Reply', 'n8n-nodes-base.code', 2, 2420, { jsCode: posted }, { executeOnce: true, y: 13 * Y }),
  // «Пост виклала?» — ряд під «Виклала» відео; змінюємо лише ще затверджений пост
  rest('HTTP - Post Action', 2200, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $json.pp.id }}&review_status=eq.approved&published_at=is.null",
    '={{ JSON.stringify($json.row) }}', { prefer: 'return=representation', y: 14 * Y }),
  node('Code - Post Action Reply', 'n8n-nodes-base.code', 2, 2420, { jsCode: ppostReply }, { executeOnce: true, y: 14 * Y }),
  // «Коли публікувати» історію — ряд під «Виклала»
  node('Code - Story When', 'n8n-nodes-base.code', 2, 2200, { jsCode: storyWhen }, { executeOnce: true, y: 15 * Y }),
  ifNode('IF - Story Go?', 2420, '={{ $json.go }}', { y: 15 * Y }),
  // замок: історію бере лише одне натискання (і не та, що вже в плані тижня)
  rest('HTTP - Lock Story', 2640, 'PATCH', "={{ $json.supabase_url }}/rest/v1/story_queue?id=eq.{{ $json.story.id }}&status=eq.new",
    "={{ JSON.stringify({ status: 'used' }) }}", { prefer: 'return=representation', y: 15 * Y }),
  ifNode('IF - Story Locked?', 2860, '={{ $json.statusCode >= 200 && $json.statusCode < 300 && Array.isArray($json.body) && $json.body.length > 0 }}', { y: 15 * Y }),
  node('Code - Story Taken', 'n8n-nodes-base.code', 2, 3080, {
    jsCode: `const r = $('Code - Story When').first().json;\nreturn [{ json: { chat_id: r.chat_id, kind: 'button', text: 'Ця історія вже в плані 🙌 Глянь в апці.', url: r.mini_app_url, button: 'Відкрити TravelLab' } }];`,
  }, { executeOnce: true, y: 16 * Y }),
  rest('HTTP - Insert Story Plan', 3080, 'POST', "={{ $('Code - Story When').first().json.supabase_url }}/rest/v1/content_plan",
    "={{ JSON.stringify($('Code - Story When').first().json.plan_row) }}", { prefer: 'return=representation', y: 15 * Y }),
  ifNode('IF - Story Plan Created?', 3300, '={{ $json.statusCode >= 200 && $json.statusCode < 300 && Array.isArray($json.body) && $json.body.length > 0 }}', { y: 15 * Y }),
  node('Telegram - Story Writing', 'n8n-nodes-base.telegram', 1.2, 3520, {
    chatId: "={{ $('Code - Story When').first().json.chat_id }}", text: "={{ $('Code - Story When').first().json.wait_text }}",
    additionalFields: { appendAttribution: false },
  }, { ...tgc, onError: 'continueRegularOutput', y: 15 * Y }),
  getAll('Supabase - Get Approved Posts', 3740, 'posts', null, { onError: 'continueRegularOutput', y: 15 * Y }),
  getAll('Supabase - Get Golden Versions', 3960, 'post_versions', 'is_golden=eq.true', { onError: 'continueRegularOutput', y: 15 * Y }),
  getAll('Supabase - Get Golden Plans', 4180, 'content_plan',
    "=id=in.({{ $('Supabase - Get Golden Versions').all().map(i => i.json.content_plan_id).filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000' }})",
    { onError: 'continueRegularOutput', y: 15 * Y }),
  getAll('Supabase - Get Rules', 4400, 'ira_rules', 'status=eq.active', { onError: 'continueRegularOutput', y: 15 * Y }),
  node('Code - Story Gen Input', 'n8n-nodes-base.code', 2, 4620, { jsCode: storyGenInput }, { executeOnce: true, y: 15 * Y }),
  node('Execute - Post Generator', 'n8n-nodes-base.executeWorkflow', 1.2, 4840, {
    source: 'database', workflowId: { __rl: true, value: CFG.generatorId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput', y: 15 * Y }),
  node('Code - Story Gen Parse', 'n8n-nodes-base.code', 2, 5060, { jsCode: storyGenParse }, { executeOnce: true, y: 15 * Y }),
  ifNode('IF - Story Generated?', 5280, '={{ $json._ok }}', { y: 15 * Y }),
  // фото під текст (SQL 011); нема функції → запасний tl_pick_media — як у Buffer Filler
  rest('HTTP - Story Photos (ranked)', 5500, 'POST', "={{ $('Code - Story When').first().json.supabase_url }}/rest/v1/rpc/tl_pick_media_ranked",
    "={{ JSON.stringify({ p_plan_id: $json.plan_id, p_count: $json.photo_count || 0, p_text: ($json.rpc || {}).p_text || null }) }}", { prefer: 'return=representation', y: 15 * Y }),
  ifNode('IF - Story Ranked?', 5720, '={{ $json.statusCode >= 200 && $json.statusCode < 300 && Array.isArray($json.body) }}', { y: 15 * Y }),
  rest('HTTP - Story Photos', 5720, 'POST', "={{ $('Code - Story When').first().json.supabase_url }}/rest/v1/rpc/tl_pick_media",
    "={{ JSON.stringify({ p_plan_id: $('Code - Story Gen Parse').first().json.plan_id, p_count: $('Code - Story Gen Parse').first().json.photo_count || 0 }) }}", { prefer: 'return=representation', y: 16 * Y }),
  rest('HTTP - Story Add Version', 5940, 'POST', "={{ $('Code - Story When').first().json.supabase_url }}/rest/v1/rpc/tl_add_version",
    `={{ JSON.stringify((() => {
  const r = { ...$('Code - Story Gen Parse').first().json.rpc };
  const okIds = (j) => j && j.statusCode >= 200 && j.statusCode < 300 && Array.isArray(j.body) ? j.body : null;
  const ranked = okIds($('HTTP - Story Photos (ranked)').first().json);
  let fallback = null;
  try { fallback = okIds($('HTTP - Story Photos').first().json); } catch (e) { fallback = null; }
  const ids = ranked || fallback || [];
  if (ids.length) r.p_media_ids = ids;
  return r;
})()) }}`, { prefer: 'return=representation', y: 15 * Y }),
  node('Code - Story Result', 'n8n-nodes-base.code', 2, 6160, { jsCode: storyResult }, { executeOnce: true, y: 15 * Y }),
  ifNode('IF - Story Done?', 6380, '={{ $json.ok }}', { y: 15 * Y }),
  // не вийшло: слот → planned (Buffer Filler / Іра підхоплять); слота нема → історія назад у чергу (кнопки знову працюють)
  rest('HTTP - Story Plan Revert', 6600, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $json.plan_id || '00000000-0000-0000-0000-000000000000' }}&review_status=eq.generating",
    "={{ JSON.stringify({ review_status: 'planned', review_note: 'Історія з бота: пост не згенерувався', updated_at: $now.toISO() }) }}", { y: 16 * Y }),
  rest('HTTP - Story Unlock', 6820, 'PATCH',
    "={{ $('Code - Story Result').first().json.supabase_url }}/rest/v1/story_queue?id=eq.{{ $('Code - Story Result').first().json.plan_id ? '00000000-0000-0000-0000-000000000000' : $('Code - Story Result').first().json.story_id }}&status=eq.used",
    "={{ JSON.stringify({ status: 'new' }) }}", { y: 16 * Y }),
  node('Telegram - Story Fail Admin', 'n8n-nodes-base.telegram', 1.2, 7040, {
    chatId: "={{ $('Code - Story Result').first().json.admin_chat_id }}", text: "={{ $('Code - Story Result').first().json.admin_text }}",
    additionalFields: { appendAttribution: false },
  }, { ...tgc, onError: 'continueRegularOutput', y: 16 * Y }),
  node('Code - Story Fail Reply', 'n8n-nodes-base.code', 2, 7260, { jsCode: `return [{ json: $('Code - Story Result').first().json }];` }, { executeOnce: true, y: 16 * Y }),
  ifNode('IF - Story Choice?', 6380, "={{ $json.kind === 'story_choice' }}", { y: Y * 2.5 }),
  node('Telegram - Reply (story choice)', 'n8n-nodes-base.telegram', 1.2, 6600, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [
        { text: '🔥 Сьогодні', additionalFields: { callback_data: "={{ 'st_now_' + $json.story_id }}" } },
        { text: '📅 Завтра', additionalFields: { callback_data: "={{ 'st_tmr_' + $json.story_id }}" } },
      ] } },
      { row: { buttons: [{ text: '🗓 У план тижня', additionalFields: { callback_data: "={{ 'st_week_' + $json.story_id }}" } }] } },
    ] },
    additionalFields: { appendAttribution: false, disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y * 2.5 }),
  ifNode('IF - Link?', 6160, "={{ $json.kind === 'link' }}", { y: Y * 1.5 }),
  node('Telegram - Reply (link)', 'n8n-nodes-base.telegram', 1.2, 6380, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [{ text: '={{ $json.button }}', additionalFields: { url: '={{ $json.url }}' } }] } },
      { row: { buttons: [{ text: '✅ Відео готово', additionalFields: { callback_data: 'video_ready' } }] } },
    ] },
    additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y * 2 }),
  ifNode('IF - Menu?', 6380, "={{ $json.kind === 'menu' }}", { y: Y * 3 }),
  node('Telegram - Reply (menu)', 'n8n-nodes-base.telegram', 1.2, 6600, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [
      { row: { buttons: [{ text: '📱 Відкрити TravelLab', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } },
      { row: { buttons: [
        { text: '📷 Фото готелю', additionalFields: { callback_data: 'photo_hotel' } },
        { text: '🏝 Фото острова', additionalFields: { callback_data: 'photo_island' } },
      ] } },
      { row: { buttons: [{ text: '🏨 Розповісти про готель', additionalFields: { callback_data: 'hotel_voice' } }] } },
      { row: { buttons: [{ text: '➕ Новий готель', additionalFields: { callback_data: 'hotel_new' } }] } },
      { row: { buttons: [{ text: '🎙 Розповісти історію', additionalFields: { callback_data: 'story' } }] } },
      { row: { buttons: [{ text: '🎬 Завантажити відео', additionalFields: { callback_data: 'video_ask' } }] } },
    ] },
    additionalFields: { appendAttribution: false, disable_web_page_preview: true },
  }, { ...tgc, onError: 'continueRegularOutput', y: Y * 4 }),
  // «📷 Фото готелю / 🏝 Фото острова / 🏨 Розповісти про готель» — ряд під «Коли публікувати»
  node('Code - Photo Step', 'n8n-nodes-base.code', 2, 2200, { jsCode: photoStep }, { executeOnce: true, y: 18 * Y }),
  driveList('HTTP - List Islands', 2200, "'" + CFG.destinationsId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", { y: 19 * Y }),
  node('Code - New Hotel Step', 'n8n-nodes-base.code', 2, 2200, { jsCode: newHotelStep }, { executeOnce: true, y: 17 * Y }),
  node('Code - Island Step', 'n8n-nodes-base.code', 2, 2420, { jsCode: islandStep }, { executeOnce: true, y: 19 * Y }),
  ifNode('IF - To Media?', 2640, '={{ !!$json.media_text }}', { y: 18.5 * Y }),
  node('Code - Media Input', 'n8n-nodes-base.code', 2, 2860, { jsCode: mediaInput }, { executeOnce: true, y: 18.5 * Y }),
  ifNode('IF - Media Ack?', 3080, '={{ !!$json.ack }}', { y: 18 * Y }),
  node('Telegram - Media Ack', 'n8n-nodes-base.telegram', 1.2, 3300, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.ack }}', additionalFields: { appendAttribution: false },
  }, { ...tgc, onError: 'continueRegularOutput', y: 18 * Y }),
  node('Execute - Media Intake', 'n8n-nodes-base.executeWorkflow', 1.2, 3080, {
    source: 'database', workflowId: { __rl: true, value: CFG.mediaIntakeId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
  }, { onError: 'continueRegularOutput', y: 19 * Y }),
  node('Code - Hotel Voice Input', 'n8n-nodes-base.code', 2, 2200, { jsCode: hvInput }, { executeOnce: true, y: 20.5 * Y }),
  node('Execute - Hotel Voice', 'n8n-nodes-base.executeWorkflow', 1.2, 2420, {
    source: 'database', workflowId: { __rl: true, value: CFG.hotelVoiceId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
  }, { onError: 'continueRegularOutput', y: 20.5 * Y }),
  ifNode('IF - Callback?', 550, '={{ !!$json.callback_id }}', { y: -Y }),
  node('Telegram - Answer Callback', 'n8n-nodes-base.telegram', 1.2, 600, { resource: 'callback', operation: 'answerQuery', queryId: '={{ $json.callback_id }}', additionalFields: {} },
    { ...tgc, onError: 'continueRegularOutput', y: -2 * Y }),
  node('Execute - Data Answer', 'n8n-nodes-base.executeWorkflow', 1.2, 6820, {
    source: 'database', workflowId: { __rl: true, value: CFG.dataAnswerId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
  }, { onError: 'continueRegularOutput' }),
]

const to = (...t) => ({ main: [t.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const branches = (t, f) => ({ main: [[{ node: t, type: 'main', index: 0 }], f ? [{ node: f, type: 'main', index: 0 }] : []] })
const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, to(names[i + 1])]))
const coreConnections = {
  'Execute Workflow Trigger': to('Code - Normalize'),
  'Webhook - Test Update': to('Code - Normalize'),
  'Code - Normalize': to('IF - Anything?'),
  'IF - Anything?': branches('IF - Callback?'),
  'IF - Callback?': branches('Telegram - Answer Callback', 'Supabase - Get Settings'),
  'Telegram - Answer Callback': to('Supabase - Get Settings'),
  ...chain('Supabase - Get Settings', 'Supabase - Get Plans', 'Supabase - Get Open Requests', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Supabase - Get Audiences', 'Supabase - Get Video Draft', 'Supabase - Get Story', 'Supabase - Get Intake Session', 'Code - Resolve', 'Switch - Route'),
  'Switch - Route': { main: [
    [{ node: 'Code - Ask', type: 'main', index: 0 }],
    [{ node: 'IF - Has Questions?', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'Code - Story Ask', type: 'main', index: 0 }],
    [{ node: 'IF - Story Voice?', type: 'main', index: 0 }],
    [{ node: 'Code - Video Ask', type: 'main', index: 0 }],
    [{ node: 'HTTP - List Inbox', type: 'main', index: 0 }],
    [{ node: 'Code - Video Voice Ask', type: 'main', index: 0 }],
    [{ node: 'Code - Video Voice Check', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'HTTP - Mark Posted', type: 'main', index: 0 }],
    [{ node: 'Code - Story When', type: 'main', index: 0 }],
    [{ node: 'Code - Photo Step', type: 'main', index: 0 }],
    [{ node: 'Code - Photo Step', type: 'main', index: 0 }],
    [{ node: 'HTTP - List Islands', type: 'main', index: 0 }],
    [{ node: 'HTTP - List Islands', type: 'main', index: 0 }],
    [{ node: 'Code - Media Input', type: 'main', index: 0 }],
    [{ node: 'Code - Hotel Voice Input', type: 'main', index: 0 }],
    [{ node: 'Code - Simple Reply', type: 'main', index: 0 }],
    [{ node: 'HTTP - Post Action', type: 'main', index: 0 }],
    [{ node: 'Code - New Hotel Step', type: 'main', index: 0 }],
  ] },
  'Code - Photo Step': to('IF - To Media?'),
  'Code - New Hotel Step': to('IF - To Media?'),
  'HTTP - List Islands': to('Code - Island Step'),
  'Code - Island Step': to('IF - To Media?'),
  'IF - To Media?': branches('Code - Media Input', 'Code - Reply'),
  // спершу «⏳ описую» (якщо «готово»), потім Media Intake без очікування
  'Code - Media Input': to('IF - Media Ack?', 'Execute - Media Intake'),
  'IF - Media Ack?': branches('Telegram - Media Ack'),
  'Code - Hotel Voice Input': to('Execute - Hotel Voice'),
  'Code - Story When': to('IF - Story Go?'),
  'IF - Story Go?': branches('HTTP - Lock Story', 'Code - Reply'),
  'HTTP - Lock Story': to('IF - Story Locked?'),
  'IF - Story Locked?': branches('HTTP - Insert Story Plan', 'Code - Story Taken'),
  'Code - Story Taken': to('Code - Reply'),
  'HTTP - Insert Story Plan': to('IF - Story Plan Created?'),
  'IF - Story Plan Created?': branches('Telegram - Story Writing', 'Code - Story Result'),
  ...chain('Telegram - Story Writing', 'Supabase - Get Approved Posts', 'Supabase - Get Golden Versions', 'Supabase - Get Golden Plans',
    'Supabase - Get Rules', 'Code - Story Gen Input', 'Execute - Post Generator', 'Code - Story Gen Parse', 'IF - Story Generated?'),
  'IF - Story Generated?': branches('HTTP - Story Photos (ranked)', 'Code - Story Result'),
  'HTTP - Story Photos (ranked)': to('IF - Story Ranked?'),
  'IF - Story Ranked?': branches('HTTP - Story Add Version', 'HTTP - Story Photos'),
  'HTTP - Story Photos': to('HTTP - Story Add Version'),
  ...chain('HTTP - Story Add Version', 'Code - Story Result', 'IF - Story Done?'),
  'IF - Story Done?': branches('Code - Reply', 'HTTP - Story Plan Revert'),
  ...chain('HTTP - Story Plan Revert', 'HTTP - Story Unlock', 'Telegram - Story Fail Admin', 'Code - Story Fail Reply', 'Code - Reply'),
  ...chain('HTTP - Mark Posted', 'Code - Posted Reply', 'Code - Reply'),
  ...chain('HTTP - Post Action', 'Code - Post Action Reply', 'Code - Reply'),
  'Code - Video Voice Ask': to('Code - Reply'),
  'Code - Video Voice Check': to('IF - Voice OK?'),
  'IF - Voice OK?': branches('HTTP - Queue Voice', 'Code - Video Voice Retry'),
  ...chain('HTTP - Queue Voice', 'Code - Video Voice Saved', 'Code - Reply'),
  'Code - Video Voice Retry': to('Code - Reply'),
  'Code - Video Ask': to('Code - Reply'),
  ...chain('HTTP - List Inbox', 'Code - Video Query', 'HTTP - List Inbox Files', 'Code - Video Summary', 'IF - Notify Admin?'),
  'IF - Notify Admin?': branches('Telegram - Notify Admin', 'Code - Video Reply'),
  ...chain('Telegram - Notify Admin', 'Code - Video Reply', 'Code - Reply'),
  'IF - Story Voice?': branches('Telegram - Get Story File', 'Code - Story Text'),
  ...chain('Telegram - Get Story File', 'OpenAI - Transcribe Story', 'Code - Story Text', 'IF - Story Long Enough?'),
  'IF - Story Long Enough?': branches('Code - Story Prompt', 'Code - Story Too Short'),
  ...chain('Code - Story Prompt', 'OpenAI - Clean Story', 'Code - Story Row', 'HTTP - Insert Story', 'Code - Story Saved', 'Code - Reply'),
  'Code - Story Ask': to('Code - Reply'),
  'Code - Story Too Short': to('Code - Reply'),
  'IF - Has Questions?': branches('IF - Voice?', 'Code - Simple Reply'),
  'IF - Voice?': branches('Telegram - Get Voice File', 'Code - Resolve Text'),
  ...chain('Telegram - Get Voice File', 'OpenAI - Transcribe', 'Code - Resolve Text', 'IF - Got Text?'),
  'IF - Got Text?': branches('Code - Parse Prompt', 'Code - Not Heard'),
  ...chain('Code - Parse Prompt', 'OpenAI - Parse Answers', 'Code - Parse Answers', 'IF - Any Answer?'),
  'IF - Any Answer?': branches('Code - Answer Items', 'Code - Not Heard'),
  ...chain('Code - Answer Items', 'HTTP - Save Answer', 'Code - After Save', 'IF - Claim?'),
  'IF - Claim?': branches('HTTP - Claim Plan', 'Code - Reply'),
  ...chain('HTTP - Claim Plan', 'Code - Claimed', 'Code - Reply'),
  'Code - Ask': to('Code - Reply'),
  'Code - Simple Reply': to('Code - Reply'),
  'Code - Not Heard': to('Code - Reply'),
  'Code - Reply': to('IF - Force Reply?'),
  'IF - Force Reply?': branches('Telegram - Ask (force reply)', 'IF - Link?'),
  'IF - Link?': branches('Telegram - Reply (link)', 'IF - Story Choice?'),
  'IF - Story Choice?': branches('Telegram - Reply (story choice)', 'IF - Menu?'),
  'IF - Menu?': branches('Telegram - Reply (menu)', 'Telegram - Reply (button)'),
  'Telegram - Reply (button)': to('IF - Run Data Answer?'),
  'IF - Run Data Answer?': branches('Code - Data Answer Input'),
  'Code - Data Answer Input': to('Execute - Data Answer'),
}
const core = { name: '[TravelLab] Voice Answers (Mini App)', nodes: coreNodes, connections: coreConnections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }

// ───── Бот: Telegram Trigger → ядро (НЕАКТИВНИЙ, див. шапку) ─────
const botWf = (coreId) => ({
  name: '[TravelLab] Ira Bot (updates)',
  nodes: [
    node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, 0, { updates: ['message', 'callback_query'], additionalFields: {} }, { ...tgc, webhookId: '0e7c4b19-5a2d-4f3e-8c61-tl-ira-bot' }),
    node('Execute - Voice Answers', 'n8n-nodes-base.executeWorkflow', 1.2, 220, {
      source: 'database', workflowId: { __rl: true, value: coreId, mode: 'id' }, mode: 'once', options: { waitForSubWorkflow: false },
    }, { onError: 'continueRegularOutput' }),
  ],
  connections: { 'Telegram Trigger': to('Execute - Voice Answers') },
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
})

const CORE_ID = process.env.TL_VOICE_CORE_ID || 'rq6TbVhPdhaaHx4k'
writeFileSync(join(here, 'voice_answers.json'), JSON.stringify(core, null, 2))
writeFileSync(join(here, 'ira_bot.json'), JSON.stringify(botWf(CORE_ID), null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') console.log('dumped', coreNodes.length, 'nodes → n8n/voice_answers.json + n8n/ira_bot.json')
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
    const c = await send(null, core)
    if (c?.id) await send(null, botWf(c.id))
  } else if (mode === 'update') {
    await send(process.argv[3], core)
    if (process.argv[4]) await send(process.argv[4], botWf(process.argv[3]))
  }
}

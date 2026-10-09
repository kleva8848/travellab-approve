// node n8n/build_review_action.mjs [dump|create|update <id>]
// Збирає n8n-воркфлоу «[TravelLab] Review Action (Mini App)»: правка Іри з апки → Post Generator → нова версія → бот Іри.
// dump — лише n8n/review_action.json (для імпорту на інший n8n при переносі на акаунти Іри).
// ID credentials/генератора — константи нижче; при переносі міняються тут (і більше ніде).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  // Telegram credential бота Іри (@travellab_studio_bot), створено 08.10
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  // Тестовий генератор з PRMPT-011 v4; після апруву Іри → WF-043 rmfe3WbNRAOGUfqS
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
  openai: { id: 'W0SZsbrcQTP4Dcjx', name: 'n8n_easypanel_p2p_mira' },
  // TL_TEST=1 → тестова копія з іншим шляхом вебхука (прод не чіпаємо)
  test: process.env.TL_TEST === '1',
}

const sb = { supabaseApi: CFG.supabase }
const node = (name, type, typeVersion, x, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [x, extra.y ?? 0], parameters, ...extra, y: undefined })
const getAll = (name, x, table, conditions, extra = {}) =>
  node(name, 'n8n-nodes-base.supabase', 1, x, {
    operation: 'getAll', tableId: table, returnAll: true,
    ...(conditions ? { filterType: 'manual', matchType: 'allFilters', filters: { conditions } } : {}),
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, ...extra })
const eq = (keyName, keyValue) => ({ keyName, condition: 'eq', keyValue })

const buildInput = `// Збирає вхід для Post Generator з плану, поточної версії і нових правок Іри
const body = $('Webhook').first().json.body || {};
const all = (n) => { try { return $(n).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0); } catch (e) { return []; } };
const plan = all('Supabase - Get Plan')[0];
if (!plan) throw new Error('content_plan не знайдено: ' + body.content_plan_id);
const versions = all('Supabase - Get Versions').sort((a, b) => a.version_no - b.version_no);
const cur = versions.find(v => v.id === plan.current_version_id) || versions[versions.length - 1] || null;
const comments = all('Supabase - Get Comments').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const fresh = comments.filter(c => c.status === 'new');
const textNew = fresh.filter(c => c.target === 'text');
// Фото-правки — лише з цього запиту (старі нерозібрані лишаються Владу, не дублюємо)
const ids = Array.isArray(body.comment_ids) ? body.comment_ids : null;
const photoNew = fresh.filter(c => c.target === 'photo' && (!ids || ids.includes(c.id)));
const earlier = comments.filter(c => c.status === 'applied' && c.target === 'text').map(c => '— ' + c.body);

const hotels = all('Supabase - Get Hotels');
const tours = all('Supabase - Get Tours');
const stories = all('Supabase - Get Stories');
const CUTOVER = new Date('2026-09-19T12:00:00Z');
const legacy = all('Supabase - Get Approved Posts').filter(p => p.content && p.created_at && new Date(p.created_at) >= CUTOVER);
// ⭐ Іри (post_versions.is_golden): спершу 3 найсвіжіші тієї ж платформи (крім самого цього поста), далі — старі схвалені
const goldenPlans = Object.fromEntries(all('Supabase - Get Golden Plans').map(p => [p.id, p]));
const golden = all('Supabase - Get Golden Versions')
  .filter(v => v.text && v.content_plan_id !== plan.id && (goldenPlans[v.content_plan_id] || {}).platform === plan.platform)
  .sort((a, b) => String(b.golden_at).localeCompare(String(a.golden_at)))
  .slice(0, 3)
  .map(v => ({ text: v.text }));
const fewshot = [...golden, ...legacy];

// Точкова правка (за замовчуванням) vs повна переробка генератором — лише коли Іра прямо просить переписати
const REWRITE = /перепиш|інш(ий|у|е) варіант|з нуля|заново|по-новому|повністю переро/i;
const editMode = !textNew.some(c => REWRITE.test(c.body));

let feedback = textNew.map(c => c.body).join('\\n');
if (feedback && earlier.length) feedback += '\\n\\nРаніше Іра вже просила по цьому посту (не повертай того, що вона прибрала):\\n' + earlier.join('\\n');

return [{ json: {
  _skip_text: textNew.length === 0,
  _plan: plan,
  _cur: cur,
  _text_comment_ids: textNew.map(c => c.id),
  _photo_comment_ids: photoNew.map(c => c.id),
  _photo_request: photoNew.map(c => c.body).join('\\n'),
  // «Нова версія готова» — тому, хто просив правку (Іра або Влад на тесті)
  _author_tg_id: (fresh[fresh.length - 1] || {}).author_tg_id || null,
  _expected_version_no: Number(body.expected_version_no ?? plan.version_no),
  _edit_mode: editMode,
  _edit_request: textNew.map(c => c.body).join('\\n\\n'),
  _earlier_raw: comments.filter(c => c.status === 'applied' && c.target === 'text').map(c => c.body),
  mode: 'regenerate',
  slot: { day: plan.day, platform: plan.platform, slot_type: plan.slot_type, pillar: plan.pillar },
  week_parity: DateTime.now().weekNumber % 2 === 0 ? 'even' : 'odd',
  tour: tours.find(t => t.tour_id === plan.tour_id) || null,
  hotel: hotels.find(h => h.hotel_id === plan.hotel_id) || null,
  story: stories.find(s => s.id === plan.story_id) || null,
  fewshot,
  old_text: cur ? cur.text : '',
  ira_feedback: feedback,
  had_feedback: !!feedback,
  passthrough: { content_plan_id: plan.id }
} }];`

const parseResult = `// Результат генератора → рядок post_versions (або помилка)
const g = $json;
const ctx = $('Code - Build Generator Input').first().json;
const photo = $('Code - Photo Edits').first().json._photo;
const cur = ctx._cur || {};
const only = !!(g && g._photo_only);
const ok = !!(g && g.status && g.status !== 'failed' && g.text);
const lintErr = (g && g.lint_errors) || [];
return [{ json: {
  _ok: ok,
  _error: ok ? '' : String((g && (g.error || g.status)) || 'генератор не повернув текст').slice(0, 300),
  _plan_id: ctx._plan.id,
  _expected_version_no: ctx._expected_version_no,
  _text_comment_ids: ctx._text_comment_ids,
  // Позначити «applied»: текстові + фото-правки, якщо їх розібрано
  _applied_ids: [...(only ? [] : ctx._text_comment_ids), ...(photo.ok ? photo.ids : [])],
  row: ok ? {
    content_plan_id: ctx._plan.id,
    version_no: ctx._plan.version_no + 1,
    text_v: (cur.text_v || 0) + (only ? 0 : 1),
    image_v: (cur.image_v || 0) + (photo.ok ? 1 : 0),
    text: g.text,
    hooks: Array.isArray(g.hooks) && g.hooks.length ? g.hooks : null,
    form: g.form || null,
    key_idea: g.key_idea || null,
    media_ids: cur.media_ids || [],
    rendered_urls: cur.rendered_urls || [],
    render_params: photo.ok ? { ...(cur.render_params || {}), photo_edits: photo.edits } : (cur.render_params || {}),
    trigger: only ? 'photo_edit' : 'comment',
    comment_id: (only ? photo.ids[0] : ctx._text_comment_ids[0]) || null,
    model: 'gpt-4.1',
    prompt_version: only ? 'photo_look' : g._edit ? 'EDIT v1' : 'PRMPT-011 v4',
    lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : []
  } : null
} }];`

const rowOnly = `return [{ json: $json.row }];`

// ───── Точкова правка: змінити лише те, що просить Іра; решта — слово в слово. Без лінтера й без примусового CTA ─────
const EDIT_SYSTEM = [
  'Ти — уважний редактор постів Ірини (TravelLab, luxury travel). Тобі дають ГОТОВИЙ пост і її правку.',
  'Головне правило: зміни ЛИШЕ те, про що вона просить. Усе, чого правка не стосується, лишається символ у символ: ті самі слова, порядок, абзаци, переноси рядків, емодзі, посилання, **жирний**.',
  'Правила:',
  '1. Не переписуй, не «покращуй», не перефразовуй і не додавай від себе нічого, про що вона не просила.',
  '2. Якщо вона дає готовий текст або фразу — встав її ДОСЛІВНО (можна лише виправити очевидну одруківку). «Постав мій текст» = весь пост дорівнює її тексту.',
  '3. «Прибери X» — прибери X і нічого більше. Посилання/стрілки/@ — прибирай, якщо просить; сам НЕ додавай нових посилань.',
  '4. Нові факти — лише якщо вона прямо просить додати факти/деталі, і ТІЛЬКИ з блоку «Факти про готель». Не вигадуй.',
  '5. Стильові правки — працюй з ІСНУЮЧИМИ реченнями, НЕ додаючи нових фактів і вражень. «Коротше» = викресли зайве (слова, підрядні, повтори), не перефразовуючи решту. «Тепліше / більше мене» = змінити тон 1–3 речень (живіші слова, звертання, «я раджу», «мені подобається») — без нових подій, людей і деталей. Щонайменше половина речень лишається без жодної зміни.',
  '5а. Абзаци й переноси рядків зберігай ЗАВЖДИ (не зливай абзаци в один).',
  '6. Останній рядок / фразу з датами, ціною, контактом (@…) не чіпай, якщо правка прямо не про них.',
  '7. НІКОЛИ не вигадуй особистого: діти, чоловік, «ми з …», «разом з дитиною», «я відчула». «Нотатки Ірини» і «Факти» використовуй ЛИШЕ коли правка прямо просить додати деталь / враження / факт — і тоді беріть рівно те, про що просить, не більше.',
  '8. Не додавай критики й мінусів («це не сюди», «не для вас», «якщо шукаєте тишу…»), рекламних штампів («рідкість», «найкращий», «розкішний», «незабутній», «ідеально»).',
  '9. Фрази, які Ірина написала сама (блок «Її власні формулювання»), лишай дослівно, якщо нова правка прямо не просить їх змінити.',
  '10. Якщо правка незрозуміла або суперечить сама собі — зроби найменшу безпечну зміну.',
  'Відповідь — СТРОГО JSON без іншого тексту: {"text": "повний текст поста після правки", "changed": "одне коротке речення українською: що саме змінено"}'
].join('\n');

const editPrompt = `// Промпт для точкової правки
const ctx = $('Code - Build Generator Input').first().json;
const h = ctx.hotel || {};
const facts = [h.name, h.key_detail, h.who_for, h.caveat && ('Нюанс: ' + h.caveat)].filter(Boolean).join('\\n');
// Її власні формулювання = довгі шматки тексту з попередніх правок, які зараз є в пості
const own = (ctx._earlier_raw || []).flatMap(b => String(b).split(/\\n+/)).map(x => x.trim()).filter(x => x.length >= 30 && (ctx.old_text || '').includes(x));
const user = 'ПОСТ ЗАРАЗ:\\n<<<\\n' + (ctx.old_text || '') + '\\n>>>\\n\\nПРАВКА ІРИНИ:\\n<<<\\n' + ctx._edit_request + '\\n>>>'
  + '\\n\\nЇї власні формулювання (не змінювати):\\n' + (own.length ? own.map(x => '— ' + x).join('\\n') : '—')
  + '\\n\\nФакти про готель (лише якщо правка просить додати деталі):\\n' + (facts || '—')
  + '\\n\\nНотатки Ірини (єдине джерело особистого):\\n' + (h.ira_notes || '—');
return [{ json: { systemPrompt: ${JSON.stringify(EDIT_SYSTEM)}, userPrompt: user } }];`

const parseEdit = `// Відповідь редактора → у форматі виходу генератора (далі — спільний Code - Parse Result)
const ctx = $('Code - Build Generator Input').first().json;
const cur = ctx._cur || {};
let out = null;
try {
  const message = Array.isArray($json.output) ? $json.output[0] : (Array.isArray($json) ? $json[0] : $json);
  const block = message && Array.isArray(message.content) ? message.content[0] : null;
  const raw = String((block && block.text) || $json.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
  out = JSON.parse(raw);
} catch (e) { out = null; }
const text = out && typeof out.text === 'string' ? out.text.trim() : '';
if (!text) return [{ json: { status: 'failed', error: 'редактор не повернув текст' } }];
return [{ json: { status: 'ok', _edit: true, text, changed: String(out.changed || ''), hooks: cur.hooks || null, form: cur.form || null, key_idea: cur.key_idea || null, lint_errors: [] } }];`

const message = `// Текст для бота Іри + кнопка, що відкриває саме цей пост в апці (і текст Владу, якщо щось не вийшло)
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const ctx = $('Code - Build Generator Input').first().json;
const plan = ctx._plan;
// Parse Result не виконувався = була лише правка до фото, і її не розібрано
let pr = null;
try { pr = $('Code - Parse Result').first().json; } catch (e) { pr = null; }
const ok = !!(pr && pr._ok);
const photo = $('Code - Photo Edits').first().json._photo;
const plat = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' }[plan.platform] || plan.platform;
const title = (ctx.hotel && ctx.hotel.name) || (ctx.tour && ctx.tour.title) || plan.pillar;
const base = String(s.mini_app_url || '').replace(/\\/$/, '');
const url = base ? base + '/?startapp=post_' + plan.id : '';
const failText = ok ? '' : '⚠️ Review Action: не вдалось переробити пост ' + plan.id + ' (' + title + ' · ' + plat + '): ' + (pr ? pr._error : 'немає нових правок');
// Частина правки до фото, яку автоматично не зроблено → Владу зрозумілим текстом
const photoNote = photo.ids.length && photo.note
  ? '📷 Іра просить до фото: «' + photo.body + '»\\n' + title + ' · ' + plat + '\\n\\n'
    + (ok && photo.ok && photo.summary ? 'Зробив: ' + photo.summary + '\\n' : '')
    + 'Автоматично не вмію: ' + photo.note
    + (pr ? '' : '\\nПост повернувся їй на перегляд, правка видна в апці.')
    + (url ? '\\n' + url : '')
  : '';
return [{ json: {
  chat_id: String(ctx._author_tg_id || s.ira_chat_id || s.admin_chat_id || ''),
  admin_chat_id: String(s.admin_chat_id || ''),
  text: ok ? '✨ Нова версія готова\\n' + title + ' · ' + plat + '\\n\\nГлянеш?' : '',
  url,
  fail_text: failText,
  photo_note: photoNote,
  admin_text: pr ? [failText, photoNote].filter(Boolean).join('\\n\\n') : (photoNote || failText)
} }];`

// ───── «До фото» вільним текстом → ті самі правки, що й чипи під фото (render_params.photo_edits[media_id], рендер — у Vercel) ─────
export const PHOTO_SYSTEM = [
  'Ти розбираєш правку Ірини (TravelLab) до ФОТО поста. Фото оформлює програма, і вона вміє лише такі правки:',
  '- text: "off" — прибрати напис з фото; "top" — напис угорі; "bottom" — напис унизу.',
  '- look: "none" — без нашої обробки (кольори й світло як в оригіналі). Синоніми: «без фільтрів», «без обробки», «як в оригіналі», «природніше», «обробка не та».',
  '- crop: "north" — кадр зсунути вгору (більше неба / верху), "south" — вниз (більше води, піску, низу), "centre" — по центру.',
  '- title: свій текст напису на фото — ДОСЛІВНО те, що вона просить написати (без лапок). kicker: дрібний рядок над написом (місце / готель), якщо вона прямо його дає.',
  'Поле, яке правка не зачіпає, не включай. null — повернути як було (наприклад «поверни напис» = text: null).',
  'НЕ вмієш (це йде в unsupported, а не в edit): інше / нове фото, додати фото, інший шрифт / колір / палітра / лого / рамка, зовсім інший стиль, ретуш, прибрати людей чи предмети, «світліше / темніше / яскравіше / контрастніше» як окрема правка (яскравість ми не регулюємо), а також кроп «щоб було видно X», коли не сказано, вгорі X чи внизу (ти не бачиш фото).',
  'slides — до яких фото правка: "cover" (перше / обкладинка — за замовчуванням для напису й кропу), "all" (усі фото — коли каже «всі», «скрізь», або для look без уточнення), або масив номерів [2, 3] якщо називає конкретні («на другому фото»).',
  'confidence 0..1 — наскільки ти впевнений, що edit — саме те, чого вона хоче. Якщо правка розмита або частково незрозуміла — нижче 0.7.',
  'Приклади: «прибери текст з фото» → {"text":"off"}, cover, 0.95. «текст вниз» → {"text":"bottom"}, cover, 0.95. «без фільтрів» → {"look":"none"}, all, 0.9. «більше неба» → {"crop":"north"}, cover, 0.85.',
  '«обріж по-іншому, щоб було видно басейн» → edit {}, confidence 0.3, unsupported "кроп під басейн — не бачу, де він на фото" (ти НЕ знаєш, де басейн, не вгадуй напрямок). «зроби світліше» → edit {}, unsupported "яскравість не регулюю". «інше фото» → edit {}, unsupported "інше фото".',
  'Відповідь — СТРОГО JSON без іншого тексту: {"edit": {…} або {}, "slides": "cover" | "all" | [номери], "confidence": 0.0, "unsupported": "що з правки не вмієш, коротко українською, або порожній рядок", "summary": "одне коротке речення українською: що зробиш"}'
].join('\n')

export const photoPrompt = `// Промпт парсера правки до фото
const ctx = $json;
const n = ((ctx._cur || {}).media_ids || []).length;
const user = 'Фото в пості: ' + n + '\\n\\nПРАВКА ІРИНИ ДО ФОТО:\\n<<<\\n' + ctx._photo_request + '\\n>>>';
return [{ json: { systemPrompt: ${JSON.stringify(PHOTO_SYSTEM)}, userPrompt: user } }];`

// Відповідь парсера → patch photo_edits (та сама перевірка значень, що й parseEdit в api/review.ts)
export const photoEdits = `const ctx = $('Code - Build Generator Input').first().json;
const out = { ok: false, ids: [], body: '', edits: null, note: '', summary: '' };
if ((ctx._photo_comment_ids || []).length) {
  out.ids = ctx._photo_comment_ids; out.body = ctx._photo_request;
  let r = null;
  try {
    const j = $('OpenAI - Parse Photo').first().json;
    const message = Array.isArray(j.output) ? j.output[0] : j;
    const block = message && Array.isArray(message.content) ? message.content[0] : null;
    const raw = String((block && block.text) || j.text || '').trim().replace(/^\\\`\\\`\\\`json\\s*|\\\`\\\`\\\`$/g, '');
    r = JSON.parse(raw);
  } catch (e) { r = null; }
  const allowed = { text: ['off', 'top', 'bottom'], look: ['none'], crop: ['centre', 'north', 'south'], title: 'text', kicker: 'text' };
  const patch = {};
  let bad = !r;
  for (const [k, v] of Object.entries((r && r.edit) || {})) {
    const rule = allowed[k];
    if (!rule) { bad = true; continue; }
    if (v === null) patch[k] = null;
    else if (rule === 'text' && typeof v === 'string' && v.trim()) patch[k] = v.replace(/\\s+/g, ' ').trim().slice(0, 140);
    else if (Array.isArray(rule) && rule.includes(v)) patch[k] = v;
    else bad = true;
  }
  const cur = ctx._cur || {};
  const media = (cur.media_ids || []).slice(0, 10);
  const s = r && r.slides;
  const targets = s === 'all' ? media : Array.isArray(s) ? s.map(x => media[Number(x) - 1]).filter(Boolean) : media.slice(0, 1);
  const conf = Number((r && r.confidence) || 0);
  out.summary = String((r && r.summary) || '');
  const unsupported = String((r && r.unsupported) || '').trim();
  if (!media.length) out.note = 'у поста ще немає фото';
  else if (!r) out.note = 'не вдалось розібрати правку';
  else if (Object.keys(patch).length && targets.length && conf >= 0.7 && !bad) {
    const edits = { ...(((cur.render_params || {}).photo_edits) || {}) };
    for (const mid of targets) {
      const next = { ...(edits[mid] || {}) };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (Object.keys(next).length) edits[mid] = next; else delete edits[mid];
    }
    out.ok = true; out.edits = edits;
    out.note = unsupported;
  } else out.note = unsupported || (conf < 0.7 ? 'не впевнений, що правильно зрозумів' : 'такої правки фото не вмію');
}
return [{ json: { ...ctx, _photo: out } }];`

const photoOnly = `// Лише правка до фото → «вихід генератора» з тим самим текстом; далі спільний Code - Parse Result
const cur = $json._cur || {};
return [{ json: { status: 'ok', _photo_only: true, text: cur.text || '', hooks: cur.hooks || null, form: cur.form || null, key_idea: cur.key_idea || null, lint_errors: [] } }];`

const ifTrue = (name, x, expr, y = 0) => node(name, 'n8n-nodes-base.if', 2.2, x, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), leftValue: expr, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
  options: {},
}, { y })

const tgCreds = CFG.telegram ? { credentials: { telegramApi: CFG.telegram } } : {}

const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2, 0, {
    httpMethod: 'POST', path: CFG.test ? 'travellab-review-action-test' : 'travellab-review-action', authentication: 'headerAuth', responseMode: 'onReceived', responseCode: 202, options: {},
  }, { webhookId: CFG.test ? '5f0c2b7e-7a1d-4c55-9b0e-tl-review-test' : '5f0c2b7e-7a1d-4c55-9b0e-tl-review-action', credentials: { httpHeaderAuth: CFG.webhookAuth } }),
  getAll('Supabase - Get Plan', 220, 'content_plan', [eq('id', "={{ $json.body.content_plan_id }}")]),
  getAll('Supabase - Get Versions', 440, 'post_versions', [eq('content_plan_id', "={{ $('Webhook').first().json.body.content_plan_id }}")]),
  getAll('Supabase - Get Comments', 660, 'review_comments', [eq('content_plan_id', "={{ $('Webhook').first().json.body.content_plan_id }}")]),
  getAll('Supabase - Get Hotels', 880, 'hotels'),
  getAll('Supabase - Get Tours', 1100, 'tours'),
  getAll('Supabase - Get Stories', 1320, 'story_queue'),
  getAll('Supabase - Get Approved Posts', 1540, 'posts'),
  // SQL 006 ще не запущено → помилку ігноруємо, лишаються старі приклади
  node('Supabase - Get Golden Versions', 'n8n-nodes-base.supabase', 1, 1600, {
    operation: 'getAll', tableId: 'post_versions', returnAll: true, filterType: 'string', filterString: 'is_golden=eq.true',
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, onError: 'continueRegularOutput' }),
  node('Supabase - Get Golden Plans', 'n8n-nodes-base.supabase', 1, 1680, {
    operation: 'getAll', tableId: 'content_plan', returnAll: true, filterType: 'string',
    filterString: "=id=in.({{ $('Supabase - Get Golden Versions').all().map(i => i.json.content_plan_id).filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000' }})",
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, onError: 'continueRegularOutput' }),
  node('Code - Build Generator Input', 'n8n-nodes-base.code', 2, 1760, { jsCode: buildInput }),
  ifTrue('IF - Photo Comments?', 1800, '={{ ($json._photo_comment_ids || []).length > 0 }}', -440),
  node('Code - Build Photo Prompt', 'n8n-nodes-base.code', 2, 1840, { jsCode: photoPrompt }, { y: -440 }),
  node('OpenAI - Parse Photo', '@n8n/n8n-nodes-langchain.openAi', 2.3, 1880, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: -440 }),
  node('Code - Photo Edits', 'n8n-nodes-base.code', 2, 1920, { jsCode: photoEdits }),
  ifTrue('IF - Photo Parsed?', 2090, '={{ $json._photo.ok }}', 440),
  node('Code - Photo Only', 'n8n-nodes-base.code', 2, 2200, { jsCode: photoOnly }, { y: 440 }),
  node('Supabase - Back To Review (photo)', 'n8n-nodes-base.supabase', 1, 2420, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('id', "={{ $('Code - Build Generator Input').first().json._plan.id }}"), eq('review_status', 'regenerating')] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [{ fieldId: 'review_status', fieldValue: 'ready_for_review' }, { fieldId: 'review_note', fieldValue: "={{ 'до фото вручну: ' + ($json._photo.note || 'немає нових правок') }}" }, { fieldId: 'updated_at', fieldValue: '={{ $now.toISO() }}' }] },
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, y: 660 }),
  node('IF - Text Comments?', 'n8n-nodes-base.if', 2.2, 1980, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'has-text', leftValue: '={{ $json._skip_text }}', rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }] },
    options: {},
  }),
  node('IF - Edit Mode?', 'n8n-nodes-base.if', 2.2, 2090, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'edit-mode', leftValue: '={{ $json._edit_mode }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }, { y: -220 }),
  node('Code - Build Edit Prompt', 'n8n-nodes-base.code', 2, 2200, { jsCode: editPrompt }, { y: -220 }),
  node('OpenAI - Apply Edit', '@n8n/n8n-nodes-langchain.openAi', 2.3, 2310, {
    modelId: { __rl: true, value: 'gpt-4.1', mode: 'id' },
    responses: { values: [{ role: 'system', content: '={{ $json.systemPrompt }}' }, { content: '={{ $json.userPrompt }}' }] },
    builtInTools: {}, options: {},
  }, { credentials: { openAiApi: CFG.openai }, onError: 'continueRegularOutput', y: -220 }),
  node('Code - Parse Edit', 'n8n-nodes-base.code', 2, 2420, { jsCode: parseEdit }, { y: -220 }),
  node('Execute - Post Generator', 'n8n-nodes-base.executeWorkflow', 1.2, 2200, {
    source: 'database', workflowId: { __rl: true, value: CFG.generatorId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput' }),
  node('Code - Parse Result', 'n8n-nodes-base.code', 2, 2420, { jsCode: parseResult }),
  node('IF - Generated?', 'n8n-nodes-base.if', 2.2, 2640, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'gen-ok', leftValue: '={{ $json._ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }),
  node('Code - Version Row', 'n8n-nodes-base.code', 2, 2860, { jsCode: rowOnly }),
  node('Supabase - Insert Version', 'n8n-nodes-base.supabase', 1, 3080, { operation: 'create', tableId: 'post_versions', dataToSend: 'autoMapInputData' }, { credentials: sb }),
  node('Supabase - Point Plan To Version', 'n8n-nodes-base.supabase', 1, 3300, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('id', '={{ $json.content_plan_id }}'), eq('version_no', "={{ $('Code - Parse Result').first().json._expected_version_no }}")] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [
      { fieldId: 'current_version_id', fieldValue: '={{ $json.id }}' },
      { fieldId: 'version_no', fieldValue: '={{ $json.version_no }}' },
      { fieldId: 'review_status', fieldValue: 'ready_for_review' },
      { fieldId: 'updated_at', fieldValue: '={{ $now.toISO() }}' },
    ] },
  }, { credentials: sb, alwaysOutputData: true }),
  node('Supabase - Mark Comments Applied', 'n8n-nodes-base.supabase', 1, 3520, {
    operation: 'update', tableId: 'review_comments',
    filterType: 'string',
    filterString: "=id=in.({{ $('Code - Parse Result').first().json._applied_ids.join(',') || '00000000-0000-0000-0000-000000000000' }})",
    dataToSend: 'defineBelow', fieldsUi: { fieldValues: [{ fieldId: 'status', fieldValue: 'applied' }] },
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true }),
  node('Supabase - Back To Changes Requested', 'n8n-nodes-base.supabase', 1, 2860, {
    operation: 'update', tableId: 'content_plan', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [eq('id', "={{ $('Code - Build Generator Input').first().json._plan.id }}"), eq('review_status', 'regenerating')] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [{ fieldId: 'review_status', fieldValue: 'changes_requested' }, { fieldId: 'review_note', fieldValue: "={{ $json._error || 'не вдалось переробити' }}" }] },
  }, { credentials: sb, alwaysOutputData: true, executeOnce: true, y: 220 }),
  getAll('Supabase - Get Settings', 3740, 'settings'),
  node('Code - Message', 'n8n-nodes-base.code', 2, 3960, { jsCode: message }),
  node('Telegram - New Version To Ira', 'n8n-nodes-base.telegram', 1.2, 4180, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', replyMarkup: 'inlineKeyboard',
    inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Подивитись', additionalFields: { web_app: { url: '={{ $json.url }}' } } }] } }] },
    additionalFields: { appendAttribution: false },
  }, { ...tgCreds, onError: 'continueRegularOutput' }),
  // Змішана правка: текст зроблено, а частину до фото — ні → Владу
  ifTrue('IF - Photo Note?', 4180, "={{ !!$json.photo_note }}", 220),
  node('Telegram - Photo Note To Admin', 'n8n-nodes-base.telegram', 1.2, 4400, {
    chatId: '={{ $json.admin_chat_id }}', text: '={{ $json.photo_note }}', additionalFields: { appendAttribution: false },
  }, { ...tgCreds, onError: 'continueRegularOutput', y: 220 }),
]

// Гілка помилки / лише фото-правки: статус назад + Владу в бот (якщо є Telegram credential)
nodes.push(
  getAll('Supabase - Get Settings (fail)', 3080, 'settings', null, { y: 220 }),
  node('Code - Fail Message', 'n8n-nodes-base.code', 2, 3300, { jsCode: message.replace(/Supabase - Get Settings'/, "Supabase - Get Settings (fail)'") }, { y: 220 }),
  node('Telegram - Fail To Admin', 'n8n-nodes-base.telegram', 1.2, 3520, {
    chatId: '={{ $json.admin_chat_id }}', text: '={{ $json.admin_text }}', additionalFields: { appendAttribution: false },
  }, { ...tgCreds, onError: 'continueRegularOutput', y: 220 }),
)

const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]))
const connections = {
  ...chain('Webhook', 'Supabase - Get Plan', 'Supabase - Get Versions', 'Supabase - Get Comments', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Supabase - Get Stories', 'Supabase - Get Approved Posts', 'Supabase - Get Golden Versions', 'Supabase - Get Golden Plans', 'Code - Build Generator Input', 'IF - Photo Comments?'),
  'IF - Photo Comments?': { main: [[{ node: 'Code - Build Photo Prompt', type: 'main', index: 0 }], [{ node: 'Code - Photo Edits', type: 'main', index: 0 }]] },
  ...chain('Code - Build Photo Prompt', 'OpenAI - Parse Photo', 'Code - Photo Edits', 'IF - Text Comments?'),
  'IF - Text Comments?': { main: [[{ node: 'IF - Edit Mode?', type: 'main', index: 0 }], [{ node: 'IF - Photo Parsed?', type: 'main', index: 0 }]] },
  'IF - Photo Parsed?': { main: [[{ node: 'Code - Photo Only', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Review (photo)', type: 'main', index: 0 }]] },
  'Code - Photo Only': { main: [[{ node: 'Code - Parse Result', type: 'main', index: 0 }]] },
  'Supabase - Back To Review (photo)': { main: [[{ node: 'Supabase - Get Settings (fail)', type: 'main', index: 0 }]] },
  'IF - Edit Mode?': { main: [[{ node: 'Code - Build Edit Prompt', type: 'main', index: 0 }], [{ node: 'Execute - Post Generator', type: 'main', index: 0 }]] },
  ...chain('Code - Build Edit Prompt', 'OpenAI - Apply Edit', 'Code - Parse Edit', 'Code - Parse Result'),
  ...chain('Execute - Post Generator', 'Code - Parse Result', 'IF - Generated?'),
  'IF - Generated?': { main: [[{ node: 'Code - Version Row', type: 'main', index: 0 }], [{ node: 'Supabase - Back To Changes Requested', type: 'main', index: 0 }]] },
  ...chain('Code - Version Row', 'Supabase - Insert Version', 'Supabase - Point Plan To Version', 'Supabase - Mark Comments Applied', 'Supabase - Get Settings', 'Code - Message'),
  'Code - Message': { main: [[{ node: 'Telegram - New Version To Ira', type: 'main', index: 0 }, { node: 'IF - Photo Note?', type: 'main', index: 0 }]] },
  'IF - Photo Note?': { main: [[{ node: 'Telegram - Photo Note To Admin', type: 'main', index: 0 }]] },
  ...chain('Supabase - Back To Changes Requested', 'Supabase - Get Settings (fail)', 'Code - Fail Message', 'Telegram - Fail To Admin'),
}

for (const n of nodes) delete n.y
const wf = {
  name: (CFG.test ? '[TEST] ' : '') + '[TravelLab] Review Action (Mini App)',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' },
}
if (!CFG.test) writeFileSync(join(here, 'review_action.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/review_action.json')
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

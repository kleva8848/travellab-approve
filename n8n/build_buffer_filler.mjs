// node n8n/build_buffer_filler.mjs [dump|create|update <id>]
// «[TravelLab] Buffer Filler D+3 (Mini App)»: щодня о 07:00 (Київ) бере слоти content_plan на сьогодні…+3 дні
// (review_status 'planned', або 'needs_data' без тексту — раптом дані вже є), перевіряє дані БЕЗ LLM (pre-gate):
//   офер → реальна ціна (tours.price_range або hotels.price_from_night) + дати (tours.dates_example);
//   готель → key_detail + who_for; Threads «власна думка» без історії → тема від Іри.
// Бракує → review_status 'needs_data' + питання Ірі в data_requests (без дублів відкритих).
// Достатньо → по одному слоту: Post Generator (той самий, що в WF-046, ⭐ few-shot) → фото (tl_pick_media) →
//   tl_add_version (trigger 'buffer_filler', без SQL 009 — 'initial') → 'ready_for_review'.
// Наприкінці — підсумок лише admin (settings.admin_chat_id). Ірі нічого.
// Ручний запуск: POST вебхук (Header Auth) {"dry_run": true, "days": 3} — dry_run за замовчуванням true:
//   нічого не пише і нічого не шле, лише повертає, що взяв би і чого бракує. Справжній прогін — {"dry_run": false}.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  telegram: { id: process.env.TL_TG_CRED_ID || 'n0IdHhMlzZgnnc7K', name: 'TravelLab Ira Bot' },
  // Тестовий генератор з PRMPT-011 v4 (як у WF-046); після апруву Іри → TL_GENERATOR_ID=rmfe3WbNRAOGUfqS (WF-043)
  generatorId: process.env.TL_GENERATOR_ID || 'VZk3w2jPwXFexId2',
}
const sb = { supabaseApi: CFG.supabase }
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

// PostgREST через credential Supabase (service role); повна відповідь, без падіння — рішення приймає Code далі
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

// ───────────────────────── Pre-gate: детермінований, без LLM ─────────────────────────
const gate = `// Які слоти брати, чого бракує, вхід для генератора. Нічого не пише.
const all = (n) => { try { return $(n).all().map(i => i.json).filter(j => j && Object.keys(j).length > 0 && !j.error); } catch (e) { return []; } };
const s = {};
for (const r of all('Supabase - Get Settings')) s[r.key] = r.value;

const hook = $('Webhook - Manual Run').isExecuted ? ($('Webhook - Manual Run').first().json.body || {}) : null;
// з вебхука — dry_run, поки прямо не сказано false; за розкладом — справжній прогін
const dryRun = hook ? !(hook.dry_run === false || hook.dry_run === 'false' || hook.dry_run === 0 || hook.dry_run === '0') : false;
const days = Math.min(Math.max(Number(hook && hook.days) || 3, 0), 14);

const zone = 'Europe/Kyiv';
// dry_run можна «перемотати» на інший день (перевірка логіки на минулих тижнях): {"today": "2026-09-28"}
const now = (dryRun && hook && /^\\d{4}-\\d{2}-\\d{2}$/.test(String(hook.today || ''))) ? DateTime.fromISO(hook.today, { zone }) : DateTime.now().setZone(zone);
const today = now.toFormat('yyyy-MM-dd');
const horizon = now.plus({ days }).toFormat('yyyy-MM-dd');
const dm = d => DateTime.fromISO(d).toFormat('dd.MM');

const hotels = Object.fromEntries(all('Supabase - Get Hotels').map(h => [h.hotel_id, h]));
const tours = Object.fromEntries(all('Supabase - Get Tours').map(t => [t.tour_id, t]));
const stories = Object.fromEntries(all('Supabase - Get Stories').map(x => [x.id, x]));
const reqs = all('Supabase - Get Data Requests');
const rules = all('Supabase - Get Rules');
const CUTOVER = new Date('2026-09-19T12:00:00Z');
const legacy = all('Supabase - Get Approved Posts').filter(p => p.content && p.created_at && new Date(p.created_at) >= CUTOVER);
const goldenPlans = Object.fromEntries(all('Supabase - Get Golden Plans').map(p => [p.id, p]));
const goldenAll = all('Supabase - Get Golden Versions').filter(v => v.text).sort((a, b) => String(b.golden_at).localeCompare(String(a.golden_at)));

// Хто про що вже питав: ключ «про що + поле» (готель/тур спільні для всіх постів, тема — на пост)
const subj = (r) => r.hotel_id ? 'h:' + r.hotel_id : r.tour_id ? 't:' + r.tour_id : 'p:' + r.content_plan_id;
const openKeys = new Set(reqs.filter(r => r.status === 'open').map(r => subj(r) + ':' + r.field));
const answered = {};
for (const r of reqs.filter(r => r.status === 'answered' && r.answer).sort((a, b) => String(a.answered_at || a.created_at).localeCompare(String(b.answered_at || b.created_at)))) answered[subj(r) + ':' + r.field] = String(r.answer);

// WF-018 поки не пише scheduled_for → дата = week_start (або тиждень created_at) + день тижня слоту.
// Лише для пошуку слотів у вікні; у БД дату не пишемо (її ставить календар при затвердженні)
const DOW = { 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6, 'Нд': 7 };
const derive = !(hook && (hook.derive_dates === false || hook.derive_dates === 'false'));
const plans = all('Supabase - Get Plans').map(p => {
  if (p.scheduled_for || !derive || !DOW[p.day] || !(p.week_start || p.created_at)) return p;
  const wk = p.week_start ? DateTime.fromISO(String(p.week_start).slice(0, 10), { zone }) : DateTime.fromISO(p.created_at).setZone(zone);
  const d = wk.startOf('week').plus({ days: DOW[p.day] - 1 }).toFormat('yyyy-MM-dd');
  return { ...p, scheduled_for: d, _date_derived: true };
});
const inWindow = p => p.scheduled_for && p.scheduled_for >= today && p.scheduled_for <= horizon;
const eligible = p => !p.published_at && (p.review_status === 'planned' || (p.review_status === 'needs_data' && !p.current_version_id));
const noDate = plans.filter(p => p.review_status === 'planned' && !p.scheduled_for).length;
const PLAT = { telegram: 'Telegram', instagram: 'Instagram', threads: 'Threads' };
const photoCount = p => (['video', 'template'].includes(p.pillar) || ['reel', 'stories'].includes(p.slot_type)) ? 0 : (p.platform === 'instagram' && String(p.slot_type || '').includes('carousel')) ? 3 : 1;

const report = [], gen = [], requests = [], needIds = [];
for (const p of plans.filter(p => eligible(p) && inWindow(p)).sort((a, b) => (a.scheduled_for + (a.slot_time || '')).localeCompare(b.scheduled_for + (b.slot_time || '')))) {
  const hotel0 = p.hotel_id ? hotels[p.hotel_id] || null : null;
  const tour0 = p.tour_id ? tours[p.tour_id] || null : null;
  const story = p.story_id ? stories[p.story_id] || null : null;
  const title = (hotel0 && hotel0.name) || (tour0 && tour0.title) || '';
  const row = { id: p.id, date: p.scheduled_for, date_derived: !!p._date_derived, time: String(p.slot_time || '').slice(0, 5) || null, platform: p.platform, slot_type: p.slot_type, pillar: p.pillar, status: p.review_status, title: title || null };
  if (p.slot_type === 'stories') { report.push({ ...row, decision: 'skip', reason: 'сторіз — Іра знімає сама / шаблон, текст не генеруємо' }); continue; }
  if (p.slot_type === 'reel' || p.pillar === 'video') { report.push({ ...row, decision: 'skip', reason: 'рілс — спершу потрібне відео, текст не генеруємо' }); continue; }

  const hotel = hotel0 ? { ...hotel0 } : null;
  const tour = tour0 ? { ...tour0 } : null;
  const missing = [];
  // need(субʼєкт, поле, питання, навіщо): якщо Іра вже відповіла, але відповідь ще не перенесли в досьє — беремо її
  const need = (o) => {
    const key = (o.hotel_id ? 'h:' + o.hotel_id : o.tour_id ? 't:' + o.tour_id : 'p:' + p.id) + ':' + o.field;
    if (answered[key]) return answered[key];
    missing.push(o.field);
    if (!openKeys.has(key)) {
      openKeys.add(key);
      requests.push({ content_plan_id: p.id, hotel_id: o.hotel_id || null, tour_id: o.tour_id || null, field: o.field, question: o.question, why_needed: o.why });
    }
    return null;
  };

  const isOffer = p.slot_type === 'offer' || String(p.pillar || '').includes('tour_offer');
  if (isOffer) {
    if (!tour && !hotel) {
      need({ field: 'offer_subject', question: 'Що пропонуємо в пості ' + (PLAT[p.platform] || p.platform) + ' на ' + dm(p.scheduled_for) + '? Готель або тур', why: 'Пост-пропозиція без готелю чи туру не вийде' });
    } else {
      const name = title || 'цей готель';
      const hasPrice = (tour && tour.price_range) || (hotel && (hotel.price_from_night || hotel.price_from));
      if (!hasPrice) {
        const a = hotel
          ? need({ hotel_id: hotel.hotel_id, field: 'price_from_night', question: 'Від якої ціни за ніч ' + name + '? Сума і валюта', why: 'У пропозиції має бути реальна ціна' })
          : need({ tour_id: tour.tour_id, field: 'price_range', question: 'Скільки коштує тур «' + name + '»? Від … до … і валюта', why: 'У пропозиції має бути реальна ціна' });
        if (a) { if (tour) tour.price_range = a; else hotel.price_from_night = a; }
      }
      if (!(tour && tour.dates_example)) {
        const a = tour
          ? need({ tour_id: tour.tour_id, field: 'dates_example', question: 'На які дати пропонуємо «' + name + '»? Наприклад, 10–17 листопада', why: 'У пропозиції мають бути реальні дати' })
          : need({ field: 'dates', question: 'На які дати пропонуємо ' + name + ' (пост ' + dm(p.scheduled_for) + ')? Наприклад, 10–17 листопада', why: 'У пропозиції мають бути реальні дати' });
        if (a) { if (tour) tour.dates_example = a; else p._dates = a; }
      }
    }
  }
  if (p.hotel_id && !hotel) missing.push('hotel_not_found');
  if (hotel) {
    const name = hotel.name || 'готель';
    if (!hotel.key_detail) { const a = need({ hotel_id: hotel.hotel_id, field: 'key_detail', question: 'Чим ' + name + ' відрізняється від схожих готелів? Одна головна деталь', why: 'Пост будується навколо однієї деталі — без неї вийдуть загальні слова' }); if (a) hotel.key_detail = a; }
    if (!hotel.who_for) { const a = need({ hotel_id: hotel.hotel_id, field: 'who_for', question: 'Кому ' + name + ' підходить найбільше? Наприклад: сімʼї з малюками, пари', why: 'Щоб пост говорив до правильних людей' }); if (a) hotel.who_for = a; }
  }
  // Без готелю, туру й історії генератор пише «ні про що» → питаємо тему (особисте) або про що пост (решта)
  let topic = null;
  const personal = ['personal_take', 'personal'].includes(p.pillar) || p.slot_type === 'personal_thought';
  if (!isOffer && !story && !hotel && !tour) {
    const where = (PLAT[p.platform] || p.platform) + ' на ' + dm(p.scheduled_for);
    topic = personal
      ? need({ field: 'topic', question: 'Про що твоя думка в ' + where + '? Одне речення-тема', why: 'Це твої думки — тему агент сам не вигадує' })
      : need({ field: 'topic', question: 'Про який готель чи тему пост у ' + where + '? Коротко', why: 'Без готелю чи теми вийде загальний текст ні про що' });
  }

  if (missing.length) {
    if (p.review_status === 'planned') needIds.push(p.id);
    report.push({ ...row, decision: 'needs_data', missing });
    continue;
  }

  // Вхід генератора — як у WF-046 (mode initial замість regenerate)
  if (hotel && hotel.price_from_night && tour && !tour.price_range) tour.price_range = 'від ' + hotel.price_from_night + ' ' + (hotel.price_currency || 'USD') + ' за ніч';
  // генератор бере ціну/дати й дозволяє CTA лише з туру → офер по готелю без туру: «тур» з ціни й дат готелю
  let genTour = tour;
  if (isOffer && hotel && !tour) genTour = {
    title: hotel.name, destination: [hotel.country, hotel.region].filter(Boolean).join(', '), segment: (hotel.tags || []).includes('family') ? 'family' : '',
    dates_example: p._dates || '', price_range: hotel.price_from_night ? 'від ' + hotel.price_from_night + ' ' + (hotel.price_currency || 'USD') + ' за ніч' : String(hotel.price_from || ''), highlights: ''
  };
  const golden = goldenAll
    .filter(v => v.content_plan_id !== p.id && (goldenPlans[v.content_plan_id] || {}).platform === p.platform)
    .slice(0, 3).map(v => ({ text: v.text }));
  const myRules = rules.filter(r => r.scope === 'global' || (r.scope === 'platform' && r.scope_value === p.platform) || (r.scope === 'pillar' && r.scope_value === p.pillar) || (r.scope === 'hotel' && r.scope_value === p.hotel_id)).map(r => r.rule_text);
  const note = topic ? 'Тема від Іри: ' + topic : (p.note || '');
  gen.push({
    plan_id: p.id, orig_status: p.review_status, version_no: Number(p.version_no || 0), photo_count: p.hotel_id ? photoCount(p) : 0,
    input: {
      mode: 'initial',
      slot: { day: p.day, platform: p.platform, slot_type: p.slot_type, pillar: p.pillar, note },
      week_parity: DateTime.fromISO(p.scheduled_for).weekNumber % 2 === 0 ? 'even' : 'odd',
      tour: genTour, hotel, story,
      fewshot: [...golden, ...legacy],
      rules: myRules,
      passthrough: { content_plan_id: p.id }
    }
  });
  report.push({ ...row, decision: 'generate', golden_examples: golden.length, rules: myRules.length, photos: p.hotel_id ? photoCount(p) : 0 });
}

const supabaseUrl = String(s.supabase_url || '').replace(/\\/$/, '');
if (!dryRun && !supabaseUrl) throw new Error('settings.supabase_url порожній (SQL 004)');
return [{ json: {
  dry_run: dryRun, today, horizon, days,
  supabase_url: supabaseUrl,
  admin_chat_id: String(s.admin_chat_id || ''),
  counts: { slots: report.length, generate: gen.length, needs_data: report.filter(r => r.decision === 'needs_data').length, skip: report.filter(r => r.decision === 'skip').length, planned_without_date: noDate, new_questions: requests.length },
  slots: report,
  questions: requests.map(r => ({ content_plan_id: r.content_plan_id, field: r.field, question: r.question, why_needed: r.why_needed })),
  _gen: gen, _requests: requests, _need_ids: needIds
} }];`

const dryReport = `// dry_run: лише звіт, без записів і без Telegram
const g = $('Code - Pre-Gate').first().json;
return [{ json: { dry_run: true, today: g.today, horizon: g.horizon, counts: g.counts, slots: g.slots, questions: g.questions } }];`

const slotsToGenerate = `// Слоти на генерацію → цикл по одному. Результати збираємо в static data цього прогону
const g = $('Code - Pre-Gate').first().json;
const sd = $getWorkflowStaticData('global');
sd.bf = { exec: $execution.id, results: [] };
const items = g._gen.map(x => ({ json: { ...x, supabase_url: g.supabase_url } }));
return items.length ? items : [{ json: { _none: true, plan_id: '00000000-0000-0000-0000-000000000000', orig_status: 'planned', supabase_url: g.supabase_url } }];`

const genInput = `return [{ json: $('Loop - Slots').first().json.input }];`

const parseGen = `// Відповідь генератора → що писати у версію
const g = $json || {};
const slot = $('Loop - Slots').first().json;
const ok = !!(g.status && g.status !== 'failed' && g.text);
const lintErr = g.lint_errors || [];
return [{ json: {
  _ok: ok,
  _error: ok ? '' : String(g.error || g.status || 'генератор не повернув текст').slice(0, 300),
  plan_id: slot.plan_id,
  photo_count: slot.photo_count,
  rpc: ok ? {
    p_content_plan_id: slot.plan_id,
    p_text: g.text,
    p_trigger: 'buffer_filler',
    p_expected_version_no: slot.version_no,
    p_hooks: Array.isArray(g.hooks) && g.hooks.length ? g.hooks : null,
    p_form: g.form || null,
    p_key_idea: g.key_idea || null,
    p_model: 'gpt-4.1',
    p_prompt_version: 'PRMPT-011 v4',
    p_lint: lintErr.length ? { errors: lintErr, attempts: g.attempts || null } : null,
    p_missing_facts: g.needs_data ? [{ field: 'unknown', note: 'генератор: бракує даних' }] : [],
    p_review_status: 'ready_for_review'
  } : null
} }];`

// Версія: фото з tl_pick_media (як «підставити фото» в апці), якщо ні — порожньо (апка підставить при відкритті)
const versionBody = (trigger, promptVersion) => `={{ JSON.stringify((() => {
  const r = { ...$('Code - Parse Generation').first().json.rpc, p_trigger: '${trigger}'${promptVersion ? `, p_prompt_version: '${promptVersion}'` : ''} };
  const pick = $('HTTP - Pick Photos').first().json;
  const ids = pick && pick.statusCode >= 200 && pick.statusCode < 300 && Array.isArray(pick.body) ? pick.body : [];
  if (ids.length) r.p_media_ids = ids;
  return r;
})()) }}`

const record = `// Підсумок одного слота → static data; помилка → повернути статус
const slot = $('Loop - Slots').first().json;
if (slot._none) return [{ json: { _revert: false } }];
const prev = $prevNode.name;
let status = 'failed', note = '';
if (prev === 'IF - Locked?') { status = 'busy'; note = 'слот уже взяли / змінився статус'; }
else if (prev === 'IF - Generated?') { note = $json._error || 'генератор не повернув текст'; }
else {
  const okHttp = $json.statusCode >= 200 && $json.statusCode < 300;
  if (okHttp) status = 'generated';
  else note = String(($json.body && ($json.body.message || $json.body.code)) || $json.error && $json.error.message || ('HTTP ' + $json.statusCode)).slice(0, 300);
}
const sd = $getWorkflowStaticData('global');
if (!sd.bf || sd.bf.exec !== $execution.id) sd.bf = { exec: $execution.id, results: [] };
sd.bf.results.push({ plan_id: slot.plan_id, status, note });
return [{ json: { _revert: status === 'failed', plan_id: slot.plan_id, orig_status: slot.orig_status, note, supabase_url: slot.supabase_url } }];`

const summary = `// Коротко Владу: скільки згенеровано, скільки чекає даних
const g = $('Code - Pre-Gate').first().json;
const sd = $getWorkflowStaticData('global');
const res = (sd.bf && sd.bf.exec === $execution.id) ? sd.bf.results : [];
delete sd.bf;
const n = res.filter(r => r.status === 'generated').length;
const failed = res.filter(r => r.status === 'failed');
const lines = ['🗂 Буфер (' + g.today + ' … ' + g.horizon + '): згенеровано ' + n + ', бракує даних ' + g.counts.needs_data];
if (g.counts.new_questions) lines.push('Нових питань Ірі: ' + g.counts.new_questions);
if (failed.length) lines.push('⚠️ Не вийшло: ' + failed.length + '\\n' + failed.slice(0, 5).map(r => '• ' + r.plan_id + ': ' + r.note).join('\\n'));
if (g.counts.planned_without_date) lines.push('Без дати (не беру): ' + g.counts.planned_without_date);
return [{ json: { chat_id: g.admin_chat_id, text: lines.join('\\n'), generated: n, needs_data: g.counts.needs_data, failed: failed.length, results: res } }];`

const ifNode = (name, x, leftValue, op, extra = {}) => node(name, 'n8n-nodes-base.if', 2.2, x, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), leftValue, rightValue: true, operator: { type: 'boolean', operation: op, singleValue: true } }] },
  options: {},
}, extra)

const LOOP_Y = 300
const nodes = [
  node('Schedule - Daily 07:00', 'n8n-nodes-base.scheduleTrigger', 1.2, 0, { rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * *' }] } }),
  node('Webhook - Manual Run', 'n8n-nodes-base.webhook', 2, 0, { httpMethod: 'POST', path: 'travellab-buffer-filler', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '8c1e4a52-3b9d-4f6e-a2c7-tl-buffer-filler', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 200 }),
  getAll('Supabase - Get Settings', 220, 'settings'),
  getAll('Supabase - Get Plans', 440, 'content_plan', 'review_status=in.(planned,needs_data)&published_at=is.null'),
  getAll('Supabase - Get Hotels', 660, 'hotels'),
  getAll('Supabase - Get Tours', 880, 'tours'),
  getAll('Supabase - Get Stories', 1100, 'story_queue'),
  getAll('Supabase - Get Data Requests', 1320, 'data_requests', 'status=in.(open,answered)', { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Approved Posts', 1540, 'posts'),
  // SQL 006 нема → помилку ігноруємо, лишаються старі приклади (як у WF-046)
  getAll('Supabase - Get Golden Versions', 1760, 'post_versions', 'is_golden=eq.true', { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Golden Plans', 1980, 'content_plan',
    "=id=in.({{ $('Supabase - Get Golden Versions').all().map(i => i.json.content_plan_id).filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000' }})",
    { onError: 'continueRegularOutput' }),
  getAll('Supabase - Get Rules', 2200, 'ira_rules', 'status=eq.active', { onError: 'continueRegularOutput' }),
  node('Code - Pre-Gate', 'n8n-nodes-base.code', 2, 2420, { jsCode: gate }, { executeOnce: true }),
  ifNode('IF - Dry Run?', 2640, '={{ $json.dry_run }}', 'true'),
  node('Code - Dry Run Report', 'n8n-nodes-base.code', 2, 2860, { jsCode: dryReport }, { y: -200 }),
  rest('HTTP - Insert Data Requests', 2860, 'POST', "={{ $json.supabase_url }}/rest/v1/data_requests",
    "={{ JSON.stringify($json._requests.length ? $json._requests : []) }}", { executeOnce: true, y: 100 }),
  rest('HTTP - Mark Needs Data', 3080, 'PATCH',
    "={{ $('Code - Pre-Gate').first().json.supabase_url }}/rest/v1/content_plan?review_status=eq.planned&id=in.({{ $('Code - Pre-Gate').first().json._need_ids.join(',') || '00000000-0000-0000-0000-000000000000' }})",
    "={{ JSON.stringify({ review_status: 'needs_data', updated_at: $now.toISO() }) }}", { executeOnce: true, y: 100 }),
  node('Code - Slots To Generate', 'n8n-nodes-base.code', 2, 3300, { jsCode: slotsToGenerate }, { executeOnce: true, y: 100 }),
  node('Loop - Slots', 'n8n-nodes-base.splitInBatches', 3, 3520, { batchSize: 1, options: {} }, { y: 100 }),
  // Замок: беремо слот, лише якщо він досі в тому ж статусі й без тексту (дубль-запуск / Іра щось змінила → пропуск)
  rest('HTTP - Lock Slot', 3740, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $json.plan_id }}&review_status=eq.{{ $json.orig_status }}&current_version_id=is.null",
    "={{ JSON.stringify({ review_status: 'generating', updated_at: $now.toISO() }) }}", { prefer: 'return=representation', y: LOOP_Y }),
  ifNode('IF - Locked?', 3960, "={{ !$('Loop - Slots').first().json._none && $json.statusCode >= 200 && $json.statusCode < 300 && Array.isArray($json.body) && $json.body.length > 0 }}", 'true', { y: LOOP_Y }),
  node('Code - Generator Input', 'n8n-nodes-base.code', 2, 4180, { jsCode: genInput }, { y: LOOP_Y }),
  node('Execute - Post Generator', 'n8n-nodes-base.executeWorkflow', 1.2, 4400, {
    source: 'database', workflowId: { __rl: true, value: CFG.generatorId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput', y: LOOP_Y }),
  node('Code - Parse Generation', 'n8n-nodes-base.code', 2, 4620, { jsCode: parseGen }, { y: LOOP_Y }),
  ifNode('IF - Generated?', 4840, '={{ $json._ok }}', 'true', { y: LOOP_Y }),
  rest('HTTP - Pick Photos', 5060, 'POST', "={{ $('Loop - Slots').first().json.supabase_url }}/rest/v1/rpc/tl_pick_media",
    "={{ JSON.stringify({ p_plan_id: $json.plan_id, p_count: $json.photo_count || 0 }) }}", { prefer: 'return=representation', y: LOOP_Y }),
  rest('HTTP - Add Version', 5280, 'POST', "={{ $('Loop - Slots').first().json.supabase_url }}/rest/v1/rpc/tl_add_version",
    versionBody('buffer_filler'), { prefer: 'return=representation', y: LOOP_Y }),
  // Без SQL 009 check-констрейнт не знає 'buffer_filler' (23514) → повтор з 'initial'
  ifNode('IF - Trigger Not Allowed?', 5500, "={{ $json.statusCode >= 400 && String(($json.body || {}).code || '') === '23514' && String(($json.body || {}).message || '').includes('trigger') }}", 'true', { y: LOOP_Y }),
  rest('HTTP - Add Version (initial)', 5720, 'POST', "={{ $('Loop - Slots').first().json.supabase_url }}/rest/v1/rpc/tl_add_version",
    versionBody('initial', 'PRMPT-011 v4 · buffer_filler'), { prefer: 'return=representation', y: LOOP_Y + 160 }),
  node('Code - Record Result', 'n8n-nodes-base.code', 2, 5940, { jsCode: record }, { y: LOOP_Y }),
  ifNode('IF - Revert?', 6160, '={{ $json._revert }}', 'true', { y: LOOP_Y }),
  rest('HTTP - Revert Slot', 6380, 'PATCH',
    "={{ $json.supabase_url }}/rest/v1/content_plan?id=eq.{{ $json.plan_id }}&review_status=eq.generating",
    "={{ JSON.stringify({ review_status: $json.orig_status, review_note: ('Buffer Filler: ' + $json.note).slice(0, 300), updated_at: $now.toISO() }) }}", { y: LOOP_Y + 160 }),
  node('Code - Summary', 'n8n-nodes-base.code', 2, 3740, { jsCode: summary }, { executeOnce: true, y: -100 }),
  node('Telegram - Summary To Admin', 'n8n-nodes-base.telegram', 1.2, 3960, {
    chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', additionalFields: { appendAttribution: false },
  }, { credentials: { telegramApi: CFG.telegram }, onError: 'continueRegularOutput', y: -100 }),
]

const to = (...targets) => ({ main: [targets.map((n) => ({ node: n, type: 'main', index: 0 }))] })
const branches = (t, f) => ({ main: [[{ node: t, type: 'main', index: 0 }], [{ node: f, type: 'main', index: 0 }]] })
const chain = (...names) => Object.fromEntries(names.slice(0, -1).map((n, i) => [n, to(names[i + 1])]))
const connections = {
  'Schedule - Daily 07:00': to('Supabase - Get Settings'),
  'Webhook - Manual Run': to('Supabase - Get Settings'),
  ...chain('Supabase - Get Settings', 'Supabase - Get Plans', 'Supabase - Get Hotels', 'Supabase - Get Tours', 'Supabase - Get Stories',
    'Supabase - Get Data Requests', 'Supabase - Get Approved Posts', 'Supabase - Get Golden Versions', 'Supabase - Get Golden Plans',
    'Supabase - Get Rules', 'Code - Pre-Gate', 'IF - Dry Run?'),
  'IF - Dry Run?': branches('Code - Dry Run Report', 'HTTP - Insert Data Requests'),
  ...chain('HTTP - Insert Data Requests', 'HTTP - Mark Needs Data', 'Code - Slots To Generate', 'Loop - Slots'),
  // splitInBatches v3: output 0 = done, output 1 = наступний слот
  'Loop - Slots': branches('Code - Summary', 'HTTP - Lock Slot'),
  'HTTP - Lock Slot': to('IF - Locked?'),
  'IF - Locked?': branches('Code - Generator Input', 'Code - Record Result'),
  ...chain('Code - Generator Input', 'Execute - Post Generator', 'Code - Parse Generation', 'IF - Generated?'),
  'IF - Generated?': branches('HTTP - Pick Photos', 'Code - Record Result'),
  ...chain('HTTP - Pick Photos', 'HTTP - Add Version', 'IF - Trigger Not Allowed?'),
  'IF - Trigger Not Allowed?': branches('HTTP - Add Version (initial)', 'Code - Record Result'),
  'HTTP - Add Version (initial)': to('Code - Record Result'),
  'Code - Record Result': to('IF - Revert?'),
  'IF - Revert?': branches('HTTP - Revert Slot', 'Loop - Slots'),
  'HTTP - Revert Slot': to('Loop - Slots'),
  'Code - Summary': to('Telegram - Summary To Admin'),
}

const wf = { name: '[TravelLab] Buffer Filler D+3 (Mini App)', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'buffer_filler.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/buffer_filler.json')
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

// node n8n/build_media_sync.mjs [dump|create|update <id>]
// «[TravelLab] Media → Storage sync»: фото з Drive (media.drive_file_id) → зменшена копія ~1600px → Supabase Storage `post-media`.
// Кожні 30 хв по 25 фото + вебхук для ручного запуску. Апка показує фото з Storage через signed URL.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CFG = {
  supabase: { id: 'oj5JHcgmtpi0FPHx', name: 'Travel Lab Test' },
  drive: { id: 'jl5ptJX1kMF34ZoI', name: 'v.clevtsov drive' },
  webhookAuth: { id: 'mO62EQmnKHlk93GW', name: 'TravelLab Approve Webhook' },
  batch: 25,
  size: 1600,
}
const sb = { supabaseApi: CFG.supabase }
let x = 0
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, typeVersion, position: [(x += 220), extra.y ?? 0], parameters, ...extra })

const prepare = `// Що синхронізувати: шлях у Storage + URL Supabase з settings
const s = {};
for (const r of $('Supabase - Get Settings').all()) s[r.json.key] = r.json.value;
const base = String(s.supabase_url || '').replace(/\\/$/, '');
if (!base) throw new Error('settings.supabase_url порожній — запусти supabase/004_post_media.sql');
return $('Supabase - Get Unsynced Media').all()
  .filter(i => i.json.media_id && i.json.drive_file_id)
  .map(i => ({ json: {
    media_id: i.json.media_id,
    drive_file_id: i.json.drive_file_id,
    storage_path: 'media/' + i.json.media_id + '.jpg',
    upload_url: base + '/storage/v1/object/post-media/media/' + encodeURIComponent(i.json.media_id) + '.jpg'
  } }));`

const thumb = `// thumbnailLink Drive → потрібний розмір (=s220 → =s${CFG.size})
const meta = $('Code - Prepare').item.json;
const link = $json.thumbnailLink || '';
return { json: {
  ...meta,
  thumb_url: link ? link.replace(/=s\\d+(-c)?$/, '=s${CFG.size}') : '',
  width: ($json.imageMediaMetadata && $json.imageMediaMetadata.width) || null,
  height: ($json.imageMediaMetadata && $json.imageMediaMetadata.height) || null,
  meta_error: $json.error ? String($json.error.message || $json.error).slice(0, 200) : (link ? '' : 'немає thumbnailLink')
} };`

const result = `// Підсумок по кожному фото: ок → storage_path, інакше sync_error
const m = $('Code - Thumb URL').item.json;
const err = m.meta_error || ($json.error ? String($json.error.message || $json.error).slice(0, 200) : '');
// розміри мініатюри пропорційні оригіналу: довша сторона = ${CFG.size}
let w = null, h = null;
if (m.width && m.height) { const k = ${CFG.size} / Math.max(m.width, m.height); w = Math.round(m.width * Math.min(k, 1)); h = Math.round(m.height * Math.min(k, 1)); }
return { json: { media_id: m.media_id, ok: !err, storage_path: m.storage_path, width: w, height: h, error: err } };`

const summary = `const items = $('Code - Result').all().map(i => i.json);
return [{ json: { synced: items.filter(i => i.ok).length, failed: items.filter(i => !i.ok).map(i => i.media_id + ': ' + i.error) } }];`

const nodes = [
  node('Schedule - Every 30 min', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }),
  node('Webhook - Manual Sync', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'travellab-media-sync', authentication: 'headerAuth', responseMode: 'lastNode', options: {} },
    { webhookId: '7d1c3a9e-2b4f-4e61-9a0c-tl-media-sync', credentials: { httpHeaderAuth: CFG.webhookAuth }, y: 200 }),
  node('Supabase - Get Unsynced Media', 'n8n-nodes-base.supabase', 1, {
    operation: 'getAll', tableId: 'media', returnAll: false, limit: CFG.batch,
    filterType: 'string', filterString: 'storage_path=is.null&drive_file_id=not.is.null&sync_error=is.null',
  }, { credentials: sb, executeOnce: true }),
  node('Supabase - Get Settings', 'n8n-nodes-base.supabase', 1, { operation: 'getAll', tableId: 'settings', returnAll: true }, { credentials: sb, executeOnce: true }),
  node('Code - Prepare', 'n8n-nodes-base.code', 2, { jsCode: prepare }),
  node('HTTP - Drive File Meta', 'n8n-nodes-base.httpRequest', 4.2, {
    url: "={{ 'https://www.googleapis.com/drive/v3/files/' + $json.drive_file_id + '?fields=thumbnailLink,mimeType,imageMediaMetadata(width,height)&supportsAllDrives=true' }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api', options: {},
  }, { credentials: { googleDriveOAuth2Api: CFG.drive }, onError: 'continueRegularOutput' }),
  node('Code - Thumb URL', 'n8n-nodes-base.code', 2, { mode: 'runOnceForEachItem', jsCode: thumb }),
  node('HTTP - Download Thumb', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.thumb_url }}',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, { credentials: { googleDriveOAuth2Api: CFG.drive }, onError: 'continueRegularOutput' }),
  node('HTTP - Upload To Storage', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: "={{ $('Code - Thumb URL').item.json.upload_url }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-upsert', value: 'true' }, { name: 'Content-Type', value: 'image/jpeg' }] },
    sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data',
    options: {},
  }, { credentials: sb, onError: 'continueRegularOutput' }),
  node('Code - Result', 'n8n-nodes-base.code', 2, { mode: 'runOnceForEachItem', jsCode: result }),
  node('IF - Synced?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'ok', leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    options: {},
  }),
  node('Supabase - Mark Synced', 'n8n-nodes-base.supabase', 1, {
    operation: 'update', tableId: 'media', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [{ keyName: 'media_id', condition: 'eq', keyValue: '={{ $json.media_id }}' }] },
    dataToSend: 'defineBelow',
    fieldsUi: { fieldValues: [
      { fieldId: 'storage_path', fieldValue: '={{ $json.storage_path }}' },
      { fieldId: 'synced_at', fieldValue: '={{ $now.toISO() }}' },
      { fieldId: 'width', fieldValue: '={{ $json.width }}' },
      { fieldId: 'height', fieldValue: '={{ $json.height }}' },
    ] },
  }, { credentials: sb }),
  node('Supabase - Mark Error', 'n8n-nodes-base.supabase', 1, {
    operation: 'update', tableId: 'media', filterType: 'manual', matchType: 'allFilters',
    filters: { conditions: [{ keyName: 'media_id', condition: 'eq', keyValue: '={{ $json.media_id }}' }] },
    dataToSend: 'defineBelow', fieldsUi: { fieldValues: [{ fieldId: 'sync_error', fieldValue: '={{ $json.error }}' }] },
  }, { credentials: sb, y: 200 }),
  node('Code - Summary', 'n8n-nodes-base.code', 2, { jsCode: summary }, { executeOnce: true }),
]

const to = (n) => ({ main: [[{ node: n, type: 'main', index: 0 }]] })
const connections = {
  'Schedule - Every 30 min': to('Supabase - Get Unsynced Media'),
  'Webhook - Manual Sync': to('Supabase - Get Unsynced Media'),
  'Supabase - Get Unsynced Media': to('Supabase - Get Settings'),
  'Supabase - Get Settings': to('Code - Prepare'),
  'Code - Prepare': to('HTTP - Drive File Meta'),
  'HTTP - Drive File Meta': to('Code - Thumb URL'),
  'Code - Thumb URL': to('HTTP - Download Thumb'),
  'HTTP - Download Thumb': to('HTTP - Upload To Storage'),
  'HTTP - Upload To Storage': to('Code - Result'),
  'Code - Result': to('IF - Synced?'),
  'IF - Synced?': { main: [[{ node: 'Supabase - Mark Synced', type: 'main', index: 0 }], [{ node: 'Supabase - Mark Error', type: 'main', index: 0 }]] },
  'Supabase - Mark Synced': to('Code - Summary'),
  'Supabase - Mark Error': to('Code - Summary'),
}
for (const n of nodes) delete n.y
const wf = { name: '[TravelLab] Media → Storage sync', nodes, connections, settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv' } }
writeFileSync(join(here, 'media_sync.json'), JSON.stringify(wf, null, 2))

const mode = process.argv[2] || 'dump'
if (mode === 'dump') {
  console.log('dumped', nodes.length, 'nodes → n8n/media_sync.json')
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

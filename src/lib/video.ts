// Сторіз / рілс: «чисте» відео (кадри без тексту, змонтоване на Mac/VPS) + живі шари тексту і знака.
// Іра редагує шари — бачить одразу, без перемонтажу; фінальний mp4 збирає воркер з того самого плану.
// Координати — у кадрі 1080×1920 (як montage-test/stories.py), прев'ю просто масштабує.

export const VW = 1080
export const VH = 1920
export const SAFE_TOP = 250
export const SAFE_BOTTOM = VH - 340
export const GOLD = '#C9B27C'

export type LineStyle = 'hook' | 'title' | 'word' | 'num' | 'sub' | 'label'

// Ті самі стилі, що в stories.py (STYLES); lh — висота рядка як у Pillow ((ascent+descent)·1.08)
export const STYLES: Record<LineStyle, { name: string; font: 'prata' | 'tenor'; size: number; gold: boolean; gap: number; track: number; upper: boolean }> = {
  hook: { name: 'Заголовок', font: 'prata', size: 84, gold: false, gap: 14, track: 0, upper: false },
  title: { name: 'Заголовок менший', font: 'prata', size: 70, gold: false, gap: 12, track: 0, upper: false },
  word: { name: 'Одне слово', font: 'prata', size: 120, gold: false, gap: 10, track: 6, upper: false },
  num: { name: 'Номер', font: 'prata', size: 110, gold: true, gap: 6, track: 4, upper: false },
  sub: { name: 'Підпис', font: 'tenor', size: 46, gold: false, gap: 12, track: 1, upper: false },
  label: { name: 'Мітка', font: 'tenor', size: 38, gold: true, gap: 10, track: 7, upper: true },
}
export const FONT = {
  prata: { family: '"Prata", serif', lh: 1.48 },
  tenor: { family: '"Tenor Sans", sans-serif', lh: 1.264 },
}

// gold — номери слів (з 0), які золотом; у stories.py це *слово*
export type VLine = { text: string; style: LineStyle; gold: number[]; maxW?: number }
// Текст прив'язаний до кадрів (from..to), а не до секунд — Ірі простіше «на кадрі 2».
// Субтитр голосу (сет 6) — sec: [від, до] у секундах (за мовою Іри); from/to там лише для старих версій апки
export type VText = { id: string; from: number; to: number; y: number; scrim: number; lines: VLine[]; sec?: [number, number] }
export type WmKind = 'wm2' | 'wm1' | 'wm3' | 'off'
export type WmPos = 'br' | 'tr' | 'bl' | 'tl'
// src — вихідний кліп кадру для «Обрати момент»: легке прев'ю (з кропом як у кадрі) + стрічка мініатюр;
// start — звідки зараз узято кадр, span — скільки секунд оригіналу він бере (секунди кліпу). null — прев'ю ще готується
export type ShotSrc = { video: string; strip: string; dur: number; start: number; span: number }
export type Shot = { t0: number; t1: number; label: string; thumb: string; src?: ShotSrc | null }

export type VideoDraft = {
  id: string
  name: string
  format: 'stories' | 'reel'
  platform: 'instagram' | 'telegram'
  place: string
  dur: number
  video: string
  poster: string
  shots: Shot[]
  texts: VText[]
  wm: { kind: WmKind; pos: WmPos; color: 'white' | 'gold' }
  cover: number
  status: 'ready_for_review' | 'approved' | 'skipped'
  updated_at?: string
  // готове відео з текстом (SQL 019, воркер final_worker.py): є — «готово ✓», бот надіслав у чат (sent_at)
  final?: { rendered_at: string | null; sent_at: string | null } | null
  render_error?: string | null
  // перемонтаж кадрів (SQL 020): queued / running — монтую, текст не правиться; done — note: що сталось з текстами; error — чому ні
  remount?: { state: RemountState; kind: RemountKind; note: string[]; error: string | null } | null
  // звук (сет 6, montage-test/music.py): музика з бібліотеки Mixkit і голос Іри з бота; voice_link — бот чекає голосове саме до цього відео
  music?: { title: string; artist: string; mood: string } | null
  voice?: { dur: number } | null
  voice_link?: string | null
  // публікація (сет 7, SQL 022): підпис до поста; рілс має ще версію без музики; dest — куди в слот:
  // channel — TG-канал автоматом, chat — Ірі в чат «виклади зараз»; delivered_at — надіслано в чат; published_at — вийшло / «✅ Виклала»
  scheduled_for?: string | null
  caption?: string
  nomusic?: boolean
  dest?: Dest
  delivered_at?: string | null
  published_at?: string | null
}
export type Dest = 'channel' | 'chat'
export type RemountKind = 'remove' | 'replace' | 'moment' | 'reorder' | 'shorter' | 'music' | 'voice' | 'novoice'
export type RemountState = 'queued' | 'running' | 'done' | 'error'
export type RemountJob = { kind: Exclude<RemountKind, 'voice'>; shot?: number; start?: number; order?: number[] }
export const MOOD: Record<string, string> = { calm: 'спокійна', romantic: 'ніжна', lounge: 'лаунж', breezy: 'легка' }
export const remounting = (d: Pick<VideoDraft, 'remount'>) => d.remount?.state === 'queued' || d.remount?.state === 'running'

// Картка на «Сьогодні»
export type VideoCard = Pick<VideoDraft, 'id' | 'name' | 'format' | 'platform' | 'place' | 'dur' | 'poster' | 'status' | 'scheduled_for' | 'dest' | 'delivered_at' | 'published_at'> & { ready?: boolean; remounting?: boolean }
// Слот плану, на який агент (montage-test/video_agent.py) не склав відео — бракує кадрів (SQL 021 video_slots)
export type VideoGap = { plan_id: string; scheduled_for: string; format: 'stories' | 'reel'; topic: string; need: string | null }
export type VideoList = { items: VideoCard[]; gaps: VideoGap[] }
// Слот за Києвом: «Вт 27.10 о 19:00» (date — «Вт 27.10», time — «19:00»)
export function slotLabel(iso: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  const wd = String(p.weekday ?? '').replace(/^./, (c) => c.toUpperCase())
  return { date: `${wd} ${p.day}.${p.month}`, time: `${p.hour}:${p.minute}` }
}

// Скільки після слоту ще чекаємо відправку (n8n кожні 5 хв + рендер) — далі «час минув, виклади вручну»; як CHAT_WINDOW_MIN / grace у server/publish_plan.ts
const CHAT_WINDOW_MS = 24 * 60 * 60_000
const CHANNEL_WINDOW_MS = 60 * 60_000

// Стан публікації затвердженого відео — для бейджа на «Сьогодні» і картки в редакторі
export type PubState = 'published' | 'delivered' | 'rendering' | 'waiting' | 'sending' | 'manual'
export function pubState(v: Pick<VideoDraft, 'status' | 'scheduled_for' | 'dest' | 'delivered_at' | 'published_at'> & { ready: boolean }, now = Date.now()): PubState | null {
  if (v.published_at) return 'published'
  if (v.status !== 'approved') return null
  if (v.delivered_at) return 'delivered'
  if (!v.ready) return 'rendering'
  const at = v.scheduled_for ? Date.parse(v.scheduled_for) : NaN
  if (!Number.isFinite(at)) return 'manual'
  if (at > now) return 'waiting'
  return now - at < (v.dest === 'channel' ? CHANNEL_WINDOW_MS : CHAT_WINDOW_MS) ? 'sending' : 'manual'
}

// Те, що Іра правує і що зберігає /api/video (решта — файли й межі кадрів — з Mac)
export type VideoPlan = Pick<VideoDraft, 'texts' | 'wm' | 'cover'>
export const planOf = (d: VideoDraft): VideoPlan => ({ texts: d.texts, wm: d.wm, cover: d.cover })

export const WM: Record<Exclude<WmKind, 'off'>, { name: string; src: string; w: number; h: number }> = {
  wm2: { name: 'Коло', src: '/wm/wm2.png', w: 150, h: 150 },
  wm1: { name: 'Довгий', src: '/wm/wm1.png', w: 330, h: 110 },
  wm3: { name: 'Рукописний', src: '/wm/wm3.png', w: 225, h: 150 },
}

export function wmBox(kind: Exclude<WmKind, 'off'>, pos: WmPos) {
  const { w, h } = WM[kind]
  const x = pos === 'br' || pos === 'tr' ? VW - 70 - w : 70
  const y = pos === 'br' || pos === 'bl' ? SAFE_BOTTOM - 30 - h : SAFE_TOP + 30
  return { x, y, w, h }
}

// Коли текст видно: з початку кадру from (після переходу) до переходу на кадр to+1; субтитр голосу — за секундами
export function textTimes(d: VideoDraft, t: VText) {
  if (t.sec) return { t0: t.sec[0], t1: Math.min(d.dur, t.sec[1]) }
  const last = d.shots.length - 1
  const t0 = t.from === 0 ? 0.2 : d.shots[t.from].t0 + 0.4
  const t1 = t.to >= last ? d.dur : d.shots[t.to + 1].t0 + 0.1
  return { t0, t1 }
}

export const words = (s: string) => s.split(/\s+/).filter(Boolean)

// Відступ перед рядком: однаковий стиль — щільно, інший — gap·2 (як у stories.py)
export const lineGap = (prev: VLine | undefined, l: VLine) => (!prev ? 0 : prev.style === l.style ? 4 : STYLES[l.style].gap * 2)

let seq = 0
export const newId = () => `t${Date.now().toString(36)}${seq++}`

// ───────────── Демо (?demo=1): 3 тестові сторіз з відео Іри 22.10 (без людей у кадрі) ─────────────
const shot = (t0: number, t1: number, label: string, thumb: string): Shot => ({ t0, t1, label, thumb })
const L = (text: string, style: LineStyle, gold: number[] = [], maxW?: number): VLine => ({ text, style, gold, ...(maxW ? { maxW } : {}) })

const DEMO: VideoDraft[] = [
  {
    id: 'demo-v1', name: '3 причини повернутися', format: 'stories', platform: 'instagram', place: 'Мальдіви', dur: 12.4,
    video: '/demo/video/web_d1.mp4', poster: '/demo/video/poster_d1.jpg', cover: 1.2, status: 'ready_for_review',
    shots: [shot(0, 4.6, 'тінь пальми', '/demo/video/d1_0.jpg'), shot(4.2, 8.4, 'захід у воді', '/demo/video/d1_1.jpg'), shot(8.0, 12.4, 'з гідролітака', '/demo/video/d1_2.jpg')],
    texts: [
      { id: 'a1', from: 0, to: 2, y: 330, scrim: 0.28, lines: [L('3 причини повернутися', 'title'), L('на Мальдіви', 'label')] },
      { id: 'a2', from: 0, to: 0, y: 1100, scrim: 0.5, lines: [L('01', 'num'), L('Вода, прозоріша', 'sub'), L('за будь-який фільтр', 'sub')] },
      { id: 'a3', from: 1, to: 1, y: 1100, scrim: 0.5, lines: [L('02', 'num'), L('Захід сонця — просто у воді', 'sub', [], 760)] },
      { id: 'a4', from: 2, to: 2, y: 1100, scrim: 0.5, lines: [L('03', 'num'), L('Острови, які видно', 'sub'), L('просто з неба', 'sub')] },
    ],
    wm: { kind: 'wm2', pos: 'br', color: 'white' },
  },
  {
    id: 'demo-v2', name: 'Острів, де час повільніший', format: 'stories', platform: 'instagram', place: 'Мальдіви', dur: 8.6,
    video: '/demo/video/web_d2.mp4', poster: '/demo/video/poster_d2.jpg', cover: 2.0, status: 'ready_for_review',
    shots: [shot(0, 4.5, 'тінь пальми', '/demo/video/d2_0.jpg'), shot(4.1, 8.6, 'захід у воді', '/demo/video/d2_1.jpg')],
    texts: [
      { id: 'b1', from: 0, to: 0, y: 400, scrim: 0.36, lines: [L('Острів, де час повільніший', 'hook', [3]), L('Мальдіви', 'label')] },
      { id: 'b2', from: 1, to: 1, y: 420, scrim: 0.36, lines: [L('Іноді найкращий план —', 'sub'), L('нікуди не поспішати', 'sub')] },
    ],
    wm: { kind: 'wm2', pos: 'br', color: 'white' },
  },
  {
    id: 'demo-v3', name: 'Мальдіви — мінімал', format: 'stories', platform: 'instagram', place: 'Мальдіви', dur: 10,
    video: '/demo/video/web_d3.mp4', poster: '/demo/video/poster_d3.jpg', cover: 6.0, status: 'ready_for_review',
    shots: [shot(0, 4.8, 'з гідролітака', '/demo/video/d3_0.jpg'), shot(4.4, 10, 'тінь пальми', '/demo/video/d3_1.jpg')],
    texts: [{ id: 'c1', from: 1, to: 1, y: 820, scrim: 0.18, lines: [L('Мальдіви', 'word')] }],
    wm: { kind: 'wm2', pos: 'br', color: 'white' },
  },
]

// Правки в демо живуть, поки відкрита апка (повернулась до списку — нічого не загубилось)
const store = new Map(DEMO.map((d) => [d.id, structuredClone(d)]))
export const demoVideos = () => [...store.values()].filter((d) => d.status !== 'skipped').map((d) => ({ ...d, ready: Boolean(d.final) }))
// демо: підпис і «✅ Виклала» живуть у тому ж сховищі
export const patchDemoVideo = (id: string, p: Partial<VideoDraft>) => { const d = store.get(id); if (d) store.set(id, { ...d, ...p }) }
export const demoVideo = (id: string) => structuredClone(store.get(id) ?? DEMO[0])
export const saveDemoVideo = (d: VideoDraft) => void store.set(d.id, structuredClone(d))
export const demoVideoGaps: VideoGap[] = [
  { plan_id: 'demo-gap', scheduled_for: '2026-10-31', format: 'stories', topic: 'Пара з приводом · сторіз', need: 'кадри одного місця, що пасують темі — 2–3 відео по 5–15 с' },
]

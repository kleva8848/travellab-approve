import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { photoIdeas, photoPreview } from '../lib/api'
import {
  blockLines, blockLook, CREAM, fromStars, GAP, GOLD, GRAPH, keepGold, LH, sameSpec, SIZE, SPEC_FONT, SPEC_TEXT_MAX, VEIL_AUTO, VEIL_MAX, WIDTH, words,
  type PhotoSpec, type SpecBlock, type SpecFont, type SpecFrame,
} from '../lib/photoSpec'
import { confirmAction, haptic, isDemo, useBackButton } from '../lib/tg'
import { Spinner } from './ui'

// Свій редактор тексту на фото (сет 5, голосові Іри 20.11: «тапнути текст і написати самій, повзунок розміру, міжрядковий»).
// Повноекранний лист: тап по тексту → пишеш на місці; тягнеш пальцем → посуваєш; повзунки, шрифт, золоте слово, вуаль.
// Прев'ю двошарове: миттєве DOM (поки тягнеш / пишеш) і через 350 мс серверне — той самий рендер, що файл у чаті.
// Зберігає лише «Зберегти» — одна нова версія поста (render_params.photo_spec[media_id]); агент цей слайд більше не чіпає

type Props = {
  planId: string
  mediaId: string
  // номер фото в каруселі (1…) — для заголовка; 0 — обкладинка (перше фото)
  slide: number
  photos: number
  busy: boolean
  onClose: () => void
  onSave: (spec: PhotoSpec | null) => Promise<boolean>
}

const FONTS: SpecFont[] = ['cormorant', 'tenor', 'hand']
const DEBOUNCE_MS = 350
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const r4 = (v: number) => Math.round(v * 10000) / 10000

export function PhotoEditor({ planId, mediaId, slide, photos, busy, onClose, onSave }: Props) {
  const [init, setInit] = useState<{ spec: PhotoSpec; frame: SpecFrame; bg: string; saved: boolean } | null>(null)
  const [spec, setSpec] = useState<PhotoSpec | null>(null)
  const [server, setServer] = useState<{ key: string; jpg: string } | null>(null)
  const [rendering, setRendering] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(0)
  const [editing, setEditing] = useState(false)
  const [ideas, setIdeas] = useState<string[]>([])
  const [ideasBusy, setIdeasBusy] = useState(false)
  const [ideasErr, setIdeasErr] = useState('')
  const seq = useRef(0)

  // Відкрили — поточна спека фото (збережена Ірою або з тексту агента) + чистий кадр + готовий вигляд
  useEffect(() => {
    let alive = true
    photoPreview(planId, mediaId, null, true)
      .then((r) => {
        if (!alive) return
        setInit({ spec: r.spec, frame: r.frame, bg: r.bg ?? '', saved: r.saved })
        setSpec(r.spec)
        setServer({ key: JSON.stringify(r.spec), jpg: r.jpg })
        setSel(Math.max(0, r.spec.blocks.findIndex((b) => b.role === 'title')))
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [planId, mediaId])

  // Серверне прев'ю (= файл): правки збираємо 350 мс, відповідь лише на останній запит
  const key = spec ? JSON.stringify(spec) : ''
  useEffect(() => {
    if (!spec || !init || key === server?.key) return
    const n = ++seq.current
    setRendering(true)
    const t = setTimeout(() => {
      photoPreview(planId, mediaId, JSON.parse(key) as PhotoSpec)
        .then((r) => { if (n === seq.current) { setServer({ key, jpg: r.jpg }); setErr('') } })
        .catch((e: unknown) => { if (n === seq.current) setErr(e instanceof Error ? e.message : String(e)) })
        .finally(() => { if (n === seq.current) setRendering(false) })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- лише коли змінилась спека

  const dirty = Boolean(init && spec && !sameSpec(init.spec, spec))
  const close = async () => {
    if (dirty && !(await confirmAction('Вийти без збереження? Зміни тексту на фото пропадуть.'))) return
    onClose()
  }
  useBackButton(true, () => void close())

  if (!init || !spec) {
    return (
      <Sheet title={slide ? `Текст на фото ${slide + 1}` : 'Текст на обкладинці'} onClose={() => onClose()}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {err ? <><div style={{ color: 'var(--bad)' }}>Не вдалося відкрити редактор: {err}</div><button className="btn sec" style={{ width: 'auto', padding: '0 18px' }} onClick={onClose}>Закрити</button></> : <><Spinner /><div className="text-[13px]" style={{ color: 'var(--hint)' }}>Відкриваю фото…</div></>}
        </div>
      </Sheet>
    )
  }

  const block = spec.blocks[sel] ?? spec.blocks[0]
  const set = (p: Partial<PhotoSpec>) => setSpec((s) => (s ? { ...s, ...p } : s))
  const setBlock = (i: number, p: Partial<SpecBlock>) => setSpec((s) => (s ? { ...s, blocks: s.blocks.map((b, k) => (k === i ? { ...b, ...p } : b)) } : s))
  const typeText = (i: number, text: string) => {
    const b = spec.blocks[i]
    setBlock(i, { text: text.slice(0, SPEC_TEXT_MAX), gold: keepGold(b.text, b.gold, text) })
  }
  const addKicker = () => {
    haptic('select')
    const blocks: SpecBlock[] = [{ role: 'kicker', text: '', font: 'tenor', size: 0.026, lh: 1.3, gold: [], cap: 'upper' }, ...spec.blocks]
    set({ blocks })
    setSel(0)
    setEditing(true)
  }
  const dropKicker = () => {
    haptic('select')
    const blocks = spec.blocks.filter((b) => b.role !== 'kicker')
    set({ blocks })
    setSel(Math.max(0, blocks.findIndex((b) => b.role === 'title')))
    setEditing(false)
  }
  const askIdeas = () => {
    haptic('select')
    setIdeasBusy(true)
    setIdeasErr('')
    const title = spec.blocks.find((b) => b.role === 'title')?.text ?? ''
    const kicker = spec.blocks.find((b) => b.role === 'kicker')?.text ?? ''
    photoIdeas(planId, title, kicker)
      .then(setIdeas)
      .catch((e: unknown) => setIdeasErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setIdeasBusy(false))
  }
  const pickIdea = (v: string) => {
    haptic('select')
    const i = spec.blocks.findIndex((b) => b.role === 'title')
    if (i < 0) return
    const p = fromStars(v)
    setBlock(i, { text: p.text, gold: p.gold })
    setSel(i)
  }
  const save = async () => {
    setEditing(false)
    await onSave(spec)
  }
  const backToAgent = async () => {
    if (!(await confirmAction('Повернути текст, який написав агент? Твій текст на цьому фото зникне.'))) return
    await onSave(null)
  }

  const fresh = Boolean(server?.jpg) && server!.key === key && !editing
  const isTitle = block.role === 'title'
  const blockWords = words(block.text)
  const label = (b: SpecBlock) => (b.role === 'kicker' ? 'Надпис зверху' : slide ? 'Підпис' : 'Заголовок')
  const veilOn = spec.veil === null

  return (
    <Sheet title={slide ? `Текст на фото ${slide + 1}${photos > 1 ? ` з ${photos}` : ''}` : 'Текст на обкладинці'} onClose={() => void close()}>
      {/* Фото закріплене зверху: правиш повзунки чи пишеш — текст на фото завжди видно */}
      <div className="shrink-0 px-4">
        <Stage
          frame={init.frame} bg={init.bg} jpg={server?.jpg ?? ''} fresh={fresh} spec={spec} sel={sel} editing={editing}
          onMove={(x, y) => set({ x, y })}
          onTap={(i) => { haptic('select'); setSel(i); setEditing(true) }}
          onBlank={() => setEditing(false)}
          onType={typeText}
        />
        <div className="mt-1.5 mb-1.5 flex min-h-[20px] items-center justify-center gap-1.5 text-center text-[12.5px] leading-tight" style={{ color: err ? 'var(--bad)' : 'var(--hint)' }}>
          {err ? `Прев'ю не вийшло: ${err}` : editing ? 'Пишеш просто на фото · Enter — новий рядок' : fresh ? '✓ Так буде у файлі · торкнись тексту — пиши, тягни — посунеш' : isDemo && !rendering ? 'Демо · торкнись тексту — пиши, тягни — посунеш' : <><span className="mini-spin" />Малюю точний вигляд…</>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {spec.blocks.map((b, i) => (
            <button key={i} className={`chip ${i === sel ? 'okc' : ''}`} style={{ fontSize: 13.5, padding: '6px 12px' }}
              onClick={() => { haptic('select'); setSel(i); setEditing(true) }}>
              {label(b)}{b.text.trim() ? '' : ' · порожньо'}
            </button>
          ))}
          {!spec.blocks.some((b) => b.role === 'kicker') && <button className="chip" style={{ fontSize: 13.5, padding: '6px 12px' }} onClick={addKicker}>+ Надпис зверху</button>}
          {block.role === 'kicker' && <button className="chip" style={{ fontSize: 13.5, padding: '6px 12px' }} onClick={dropKicker}>Прибрати надпис</button>}
        </div>

        <div className="card mt-2.5">
          <div className="text-[13px] font-semibold">Шрифт · {label(block).toLowerCase()}</div>
          <div className="qchips" style={{ marginTop: 6 }}>
            {FONTS.map((f) => (
              <button key={f} className={block.font === f ? 'on' : ''} style={{ fontFamily: SPEC_FONT[f].family, fontWeight: SPEC_FONT[f].weight, fontSize: f === 'hand' ? 16 : 15 }}
                onClick={() => { haptic('select'); setBlock(sel, { font: f }) }}>{SPEC_FONT[f].name}</button>
            ))}
            {block.font !== 'hand' && (
              <button className={block.cap === 'upper' ? 'on' : ''} onClick={() => { haptic('select'); setBlock(sel, { cap: block.cap === 'upper' ? null : 'upper' }) }}>ВЕЛИКИМИ</button>
            )}
          </div>
          <Slider name="Розмір" value={block.size} min={SIZE.min} max={SIZE.max} step={0.001} show={`${Math.round(block.size * 1000)}`} onChange={(v) => setBlock(sel, { size: r4(v) })} />
          <Slider name="Між рядками" value={block.lh} min={LH.min} max={LH.max} step={0.02} show={block.lh.toFixed(2)} onChange={(v) => setBlock(sel, { lh: r4(v) })} />
          {blockWords.length > 0 && (
            <>
              <div className="mt-3 text-[13px] font-semibold">Золотом — торкнись слова</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {blockWords.map((w, wi) => {
                  const on = block.gold.includes(wi)
                  return (
                    <button key={wi} className="rounded-md px-2 py-0.5 text-[14px]" style={{ background: on ? GOLD : 'var(--bg2)', color: on ? '#2A211B' : 'var(--text)' }}
                      onClick={() => { haptic('select'); setBlock(sel, { gold: on ? block.gold.filter((g) => g !== wi) : [...block.gold, wi].sort((a, b) => a - b) }) }}>{w}</button>
                  )
                })}
              </div>
            </>
          )}
          {isTitle && (
            <>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[13px] font-semibold">Ідеї від агента</span>
                <button className="chip" disabled={ideasBusy} onClick={askIdeas}>{ideasBusy ? '⏳ Думаю… до 20 с' : ideas.length ? '✨ Ще варіанти' : '✨ Варіанти'}</button>
              </div>
              {ideasErr && <div className="mt-1.5 text-[12.5px]" style={{ color: 'var(--bad)' }}>{ideasErr}</div>}
              {ideas.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  <div className="text-[12.5px]" style={{ color: 'var(--hint)' }}>Лише підказки — торкнись, далі правиш як хочеш:</div>
                  {ideas.map((v) => {
                    const p = fromStars(v)
                    return (
                      <button key={v} className="rounded-lg px-3 py-2 text-left text-[14.5px]" style={{ background: 'var(--bg2)', outline: p.text === block.text ? '2px solid var(--accent)' : 'none' }} onClick={() => pickIdea(v)}>
                        {words(p.text).map((w, wi) => <span key={wi} style={p.gold.includes(wi) ? { color: GOLD, fontWeight: 600 } : undefined}>{wi ? ' ' : ''}{w}</span>)}
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className="card mt-2.5">
          <div className="text-[13px] font-semibold">Увесь текст</div>
          <Slider name="Ширина" value={spec.w} min={WIDTH.min} max={WIDTH.max} step={0.01} show={`${Math.round(spec.w * 100)}%`} onChange={(v) => set({ w: r4(v), x: 0.5 + clamp(spec.x - 0.5, -(1 - v) / 2, (1 - v) / 2) })} />
          <div className="mt-3 text-[13px] font-semibold">Колір тексту</div>
          <div className="seg mt-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className={spec.color === 'light' ? 'on' : ''} onClick={() => { haptic('select'); set({ color: 'light' }) }}>Світлий</button>
            <button className={spec.color === 'dark' ? 'on' : ''} onClick={() => { haptic('select'); set({ color: 'dark' }) }}>Темний</button>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[13px] font-semibold">{spec.color === 'dark' ? 'Світла вуаль під текстом' : 'Затемнення під текстом'}</span>
            <button className={`chip ${veilOn ? 'okc' : ''}`} onClick={() => { haptic('select'); set({ veil: veilOn ? VEIL_AUTO : null }) }}>{veilOn ? 'Авто ✓' : 'Авто'}</button>
          </div>
          <Slider name="" value={spec.veil ?? VEIL_AUTO} min={0} max={VEIL_MAX} step={0.01} show={veilOn ? 'авто' : `${Math.round((spec.veil ?? 0) * 100)}%`} onChange={(v) => set({ veil: r4(v) })} />
          {Math.abs(spec.x - 0.5) > 0.001 && (
            <button className="btn sec mt-3" style={{ height: 38, fontSize: 14 }} onClick={() => { haptic('select'); set({ x: 0.5 }) }}>↔ Повернути по центру</button>
          )}
        </div>

        {init.saved && (
          <button className="mx-auto mt-4 block text-[13.5px]" style={{ color: 'var(--hint)' }} disabled={busy} onClick={() => void backToAgent()}>Повернути текст агента</button>
        )}
      </div>

      <div className="bbar">
        <button className="btn sec" disabled={busy} onClick={() => void close()}>Скасувати</button>
        <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Зберігаю…' : 'Зберегти'}</button>
      </div>
    </Sheet>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }} role="dialog" aria-label={title}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <b className="text-[16px]">{title}</b>
        <button className="chip" style={{ fontSize: 14, padding: '5px 11px' }} aria-label="Закрити" onClick={onClose}>✕</button>
      </div>
      {children}
    </div>
  )
}

function Slider({ name, value, min, max, step, show, onChange }: { name: string; value: number; min: number; max: number; step: number; show: string; onChange: (v: number) => void }) {
  return (
    <label className="mt-3 block">
      {name && (
        <span className="flex items-center justify-between text-[13px] font-semibold">
          {name}<span className="font-normal tabular-nums" style={{ color: 'var(--hint)' }}>{show}</span>
        </span>
      )}
      <input type="range" className="range mt-1 w-full" min={min} max={max} step={step} value={value} aria-label={name || show}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

// ───────────── Фото + текст: кадр у пікселях файлу (як малює сервер), масштабований під ширину ─────────────

type StageProps = {
  frame: SpecFrame
  bg: string
  jpg: string
  fresh: boolean
  spec: PhotoSpec
  sel: number
  editing: boolean
  onMove: (x: number, y: number) => void
  onTap: (i: number) => void
  onBlank: () => void
  onType: (i: number, text: string) => void
}

function Stage({ frame: f, bg, jpg, fresh, spec, sel, editing, onMove, onTap, onBlank, onType }: StageProps) {
  const box = useRef<HTMLDivElement>(null)
  const blockRef = useRef<HTMLDivElement>(null)
  const [bw, setBw] = useState(300)
  const [bh, setBh] = useState(0)
  const drag = useRef<{ i: number; px: number; py: number; x0: number; y0: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setBw(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Висота блоку тексту (у пікселях файлу) — для меж перетягування і DOM-вуалі
  useLayoutEffect(() => { setBh(blockRef.current?.offsetHeight ?? 0) })

  const k = bw / f.w
  const iw = f.w - 2 * f.pad
  const ih = f.h - 2 * f.pad - 2 * f.inset
  const cx = f.pad + spec.x * iw
  const cy = f.pad + f.inset + spec.y * ih
  const color = spec.color === 'dark' ? GRAPH : CREAM
  const shadow = spec.color === 'dark' ? 'none' : '0 1px 3px rgba(0,0,0,0.45), 0 2px 18px rgba(0,0,0,0.45)'
  const gap = Math.round(f.w * GAP)
  const shown = spec.blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => b.text.trim() || (editing && i === sel))

  const down = (e: RPointerEvent, i: number) => {
    if (editing && i === sel) return // пише в полі — не тягнемо
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { i, px: e.clientX, py: e.clientY, x0: spec.x, y0: spec.y, moved: false }
  }
  const move = (e: RPointerEvent) => {
    const g = drag.current
    if (!g) return
    if (!g.moved && Math.hypot(e.clientX - g.px, e.clientY - g.py) < 7) return
    g.moved = true
    const hw = spec.w / 2
    let x = clamp(g.x0 + (e.clientX - g.px) / k / iw, hw, 1 - hw)
    if (Math.abs(x - 0.5) < 0.03) x = 0.5 // тексти по центру (правило Іри) — прилипає до центру
    const hh = Math.min(0.5, bh / 2 / ih)
    const y = clamp(g.y0 + (e.clientY - g.py) / k / ih, hh, 1 - hh)
    onMove(r4(x), r4(y))
  }
  const up = (e: RPointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    e.stopPropagation()
    if (!g.moved) onTap(g.i)
  }

  // DOM-вуаль (лише поки сервер не намалював): як softVeil — повна під текстом, м'яко сходить, біля краю — до краю
  const veil = (() => {
    if (fresh || !shown.length || !bh) return null
    const a = spec.veil ?? VEIL_AUTO
    if (a <= 0) return null
    const H = f.h - 2 * f.pad
    const y0 = cy - bh / 2 - f.pad
    const y1 = cy + bh / 2 - f.pad
    const m = H * 0.05
    const fe = H * 0.22
    const top = y0 < H * 0.25 ? 0 : Math.max(0, y0 - m - fe)
    const bot = y1 > H * 0.75 ? H : Math.min(H, y1 + m + fe)
    const c = spec.color === 'dark' ? `255,255,255,${a * 0.45}` : `0,0,0,${a}`
    const z = spec.color === 'dark' ? '255,255,255,0' : '0,0,0,0'
    const s0 = y0 < H * 0.25 ? 0 : Math.max(0, y0 - m - top)
    const s1 = Math.min(bot - top, y1 + m - top)
    return (
      <div className="pointer-events-none absolute" style={{
        left: f.pad, width: iw, top: f.pad + top, height: bot - top,
        background: `linear-gradient(to bottom, rgba(${s0 > 0 ? z : c}) 0px, rgba(${c}) ${s0}px, rgba(${c}) ${s1}px, rgba(${y1 > H * 0.75 ? c : z}) ${bot - top}px)`,
      }} />
    )
  })()

  return (
    <div className="mx-auto" style={{ maxWidth: `min(100%, calc(44vh * ${f.w / f.h}))` }}>
      <div ref={box} data-stage className="relative w-full overflow-hidden rounded-lg" style={{ aspectRatio: `${f.w} / ${f.h}`, background: 'var(--bg2)', boxShadow: 'var(--shadow)', touchAction: 'none', overflow: 'clip' }}
        onPointerDown={() => onBlank()}>
        {bg && <img src={bg} alt="" className="absolute inset-0 h-full w-full" draggable={false} style={{ objectFit: 'cover' }} />}
        {jpg && <img src={jpg} alt="Готовий вигляд фото" className="absolute inset-0 h-full w-full" draggable={false} style={{ opacity: fresh ? 1 : 0, transition: 'opacity .12s' }} />}
        <div className="absolute top-0 left-0" style={{ width: f.w, height: f.h, transform: `scale(${k})`, transformOrigin: '0 0' }} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null }}>
          {veil}
          {shown.length > 0 && (
            <div ref={blockRef} className="absolute flex flex-col items-center" style={{
              left: cx, top: cy, width: spec.w * iw, transform: 'translate(-50%, -50%)', textAlign: 'center', color, textShadow: shadow,
            }}>
              {shown.map(({ b, i }, n) => (
                <div key={i} className="flex w-full flex-col items-center" style={{ marginTop: n ? gap : 0, cursor: 'grab', opacity: fresh && !(editing && i === sel) ? 0 : 1, outline: editing && i === sel ? `${Math.max(2, 2 / k)}px dashed rgba(255,255,255,.75)` : 'none', outlineOffset: 3 / k }}
                  onPointerDown={(e) => down(e, i)}>
                  {editing && i === sel ? <BlockInput b={b} f={f} color={color} onType={(t) => onType(i, t)} /> : <BlockView b={b} f={f} gap={gap} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Рядки блоку — та сама будова, що specBlock у server/overlay.ts (слова flex-елементами, відступ = пробіл шрифту)
function BlockView({ b, f, gap }: { b: SpecBlock; f: SpecFrame; gap: number }) {
  const { font, size, upper, track, sp } = blockLook(b, f)
  const gold = useMemo(() => new Set(b.gold), [b.gold])
  const base = { fontFamily: font.family, fontWeight: font.weight, fontSize: size, lineHeight: b.lh, letterSpacing: track, textTransform: upper ? 'uppercase' as const : 'none' as const }
  return (
    <>
      {blockLines(b.text).map((groups, li) => groups === null
        ? <div key={li} style={{ height: gap }} />
        : (
          <div key={li} className="flex w-full flex-wrap justify-center" style={{ ...base, columnGap: sp }}>
            {groups.map((g) => (
              <div key={g[0].n} className="flex" style={{ columnGap: sp }}>
                {g.map((w) => <span key={w.n} style={gold.has(w.n) ? { color: GOLD } : undefined}>{w.text}</span>)}
              </div>
            ))}
          </div>
        ))}
    </>
  )
}

// Пишеш просто на фото: поле тим самим шрифтом і кеглем на місці блоку
function BlockInput({ b, f, color, onType }: { b: SpecBlock; f: SpecFrame; color: string; onType: (t: string) => void }) {
  const { font, size, upper, track } = blockLook(b, f)
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  return (
    <textarea ref={ref} value={b.text} rows={1} maxLength={140} spellCheck={false}
      placeholder={b.role === 'kicker' ? 'Країна · Готель' : 'Твій текст'}
      onChange={(e) => onType(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      className="photo-input block w-full resize-none overflow-hidden bg-transparent text-center outline-none"
      style={{ fontFamily: font.family, fontWeight: font.weight, fontSize: size, lineHeight: b.lh, letterSpacing: track, textTransform: upper ? 'uppercase' : 'none', color, padding: 0, border: 0 }} />
  )
}

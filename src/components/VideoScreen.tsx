import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { confirmAction, haptic, useBackButton } from '../lib/tg'
import {
  FONT, GOLD, SAFE_BOTTOM, SAFE_TOP, STYLES, VH, VW, WM, demoVideo, lineGap, newId, saveDemoVideo, textTimes, wmBox, words,
  type LineStyle, type VideoDraft, type VLine, type VText, type WmKind, type WmPos,
} from '../lib/video'

const FADE = 0.45
const POS: { name: string; y: number }[] = [{ name: 'Вгорі', y: 330 }, { name: 'Центр', y: 820 }, { name: 'Внизу', y: 1150 }]
const SCRIM: { name: string; a: number }[] = [{ name: 'Без', a: 0 }, { name: 'Легке', a: 0.28 }, { name: 'Сильне', a: 0.5 }]
const WM_POS: { id: WmPos; name: string }[] = [{ id: 'tl', name: '↖ ліворуч вгорі' }, { id: 'tr', name: '↗ праворуч вгорі' }, { id: 'bl', name: '↙ ліворуч унизу' }, { id: 'br', name: '↘ праворуч унизу' }]
const FORMAT = { stories: 'Сторіз', reel: 'Рілс' }

type Tab = 'text' | 'wm' | 'shots'

// Редактор сторіз/рілсу: відео + живі шари тексту і знака. Зараз — лише демо (?demo=1), дані з lib/video
export function VideoScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<VideoDraft>(() => demoVideo(id))
  const [saved, setSaved] = useState(() => JSON.stringify(demoVideo(id)))
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('text')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [toast, setToast] = useState('')
  const vref = useRef<HTMLVideoElement>(null)
  const dirty = JSON.stringify(d) !== saved

  useBackButton(true, onBack)

  useEffect(() => {
    if (!toast) return
    const x = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(x)
  }, [toast])

  // Час відео → які тексти видно (rAF, щоб поява/зникнення були плавні)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = vref.current
      if (v) setT(v.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seek = (s: number, pause = true) => {
    const v = vref.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(d.dur - 0.05, s))
    if (pause) { v.pause(); setPlaying(false) }
  }
  const togglePlay = () => {
    const v = vref.current
    if (!v) return
    if (v.paused) { setSel(null); void v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) }
  }

  // Вибрала текст — ставимо відео на його кадр і паузу, щоб бачити, що редагуєш
  const select = (tid: string | null) => {
    setSel(tid)
    const tx = d.texts.find((x) => x.id === tid)
    if (tx) {
      const { t0, t1 } = textTimes(d, tx)
      seek(Math.min(t0 + 0.8, (t0 + t1) / 2))
      setTab('text')
    }
  }

  const upd = (fn: (x: VideoDraft) => void) => setD((cur) => { const n = structuredClone(cur); fn(n); return n })
  const updText = (tid: string, fn: (x: VText) => void) => upd((n) => { const x = n.texts.find((q) => q.id === tid); if (x) fn(x) })

  const curText = d.texts.find((x) => x.id === sel)

  const addText = () => {
    const shotNow = Math.max(0, d.shots.findIndex((s) => t >= s.t0 && t < s.t1))
    const tx: VText = { id: newId(), from: shotNow, to: shotNow, y: 820, scrim: 0.28, lines: [{ text: 'Новий текст', style: 'hook', gold: [] }] }
    upd((n) => { n.texts.push(tx) })
    haptic('tap')
    setTimeout(() => select(tx.id), 0)
  }

  const removeText = async (tid: string) => {
    if (!(await confirmAction('Прибрати цей текст з відео?'))) return
    upd((n) => { n.texts = n.texts.filter((x) => x.id !== tid) })
    setSel(null)
  }

  const save = (msg: string) => {
    saveDemoVideo(d)
    setSaved(JSON.stringify(d))
    haptic('success')
    setToast(msg)
  }

  const approve = () => {
    upd((n) => { n.status = 'approved' })
    saveDemoVideo({ ...d, status: 'approved' })
    setSaved(JSON.stringify({ ...d, status: 'approved' }))
    haptic('success')
    setToast('Затверджено — відео з цим текстом зберу і надішлю в чат')
  }

  const reset = () => { setD(JSON.parse(saved)); setSel(null) }
  const soon = (what: string) => { haptic('tap'); setToast(`${what} — наступний крок розробки`) }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`chip ${d.platform === 'instagram' ? 'ig' : 'tg'}`}>{d.platform === 'instagram' ? 'Instagram' : 'Telegram'}</span>
          <span className="chip">{FORMAT[d.format]}</span>
          <span className="chip">{d.place}</span>
          {d.status === 'approved' && <span className="chip okc">затверджено</span>}
          <span className="chip warn">демо</span>
        </div>
        <div className="serif mt-2 mb-3 text-[22px] leading-[1.15]">{d.name}</div>

        {/* Поки редагує текст — відео менше і «прилипає» вгорі, щоб правки було видно під час набору */}
        <div className="sticky z-10 -mx-4 px-4 pt-3 pb-2" style={{ top: -12, background: 'var(--bg)' }}>
          <Preview d={d} t={t} sel={sel} small={sel !== null} vref={vref} onSelect={select} onMove={(tid, y) => updText(tid, (x) => { x.y = y })} onTap={togglePlay} />
          <Timeline d={d} t={t} playing={playing} small={sel !== null} onPlay={togglePlay} onSeek={(s) => seek(s)} />
          {sel === null && (
            <div className="mt-1.5 text-center text-[12.5px]" style={{ color: 'var(--hint)' }}>
              Торкнись тексту на відео, щоб змінити. Потягни — щоб посунути.
            </div>
          )}
        </div>

        <div className="seg mt-4" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          {(['text', 'wm', 'shots'] as Tab[]).map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => { haptic('select'); setTab(k); if (k !== 'text') setSel(null) }}>
              {k === 'text' ? 'Текст' : k === 'wm' ? 'Знак' : 'Кадри'}
            </button>
          ))}
        </div>

        {tab === 'text' && (
          <>
            <div className="qchips">
              {d.texts.map((x, i) => (
                <button key={x.id} className={x.id === sel ? 'on' : ''} onClick={() => select(x.id === sel ? null : x.id)}>
                  {i + 1} · {short(x.lines[0]?.text ?? '')}
                </button>
              ))}
              <button onClick={addText}>＋ Додати текст</button>
            </div>
            {curText ? (
              <TextEditor d={d} x={curText} onChange={(fn) => updText(curText.id, fn)} onRemove={() => void removeText(curText.id)} />
            ) : (
              <div className="card mt-3 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
                Обери текст угорі або торкнись його на відео. Тут можна змінити слова, шрифт, золото, місце, на яких кадрах видно.
              </div>
            )}
          </>
        )}

        {tab === 'wm' && <WmEditor d={d} onChange={upd} />}

        {tab === 'shots' && (
          <>
            <div className="card mt-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {d.shots.map((s, i) => {
                  const on = t >= s.t0 && t < s.t1
                  return (
                    <button key={i} className="shrink-0 text-left" onClick={() => seek(s.t0 + 0.5)}>
                      <span className="relative block overflow-hidden rounded-lg" style={{ width: 72, height: 128, outline: on ? '2px solid var(--text)' : 'none', outlineOffset: 1 }}>
                        <img src={s.thumb} alt="" className="h-full w-full object-cover" />
                        <span className="absolute top-1 left-1 rounded-full px-1.5 text-[11px] font-semibold" style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}>{i + 1}</span>
                      </span>
                      <span className="mt-1 block w-[72px] truncate text-[11.5px]" style={{ color: 'var(--hint)' }}>{s.label}</span>
                    </button>
                  )
                })}
              </div>
              <div className="qchips">
                <button onClick={() => soon('Прибрати кадр')}>Прибрати кадр</button>
                <button onClick={() => soon('Інший кадр')}>Інший кадр</button>
                <button onClick={() => soon('Коротше')}>Коротше</button>
                <button onClick={() => soon('Інша музика')}>Інша музика</button>
              </div>
            </div>
            <div className="card mt-3">
              <div className="flex items-center gap-3">
                <img src={d.poster} alt="" className="rounded-md object-cover" style={{ width: 54, height: 96 }} />
                <div className="min-w-0 flex-1">
                  <b className="block text-[14.5px]">Обкладинка</b>
                  <span className="text-[13px]" style={{ color: 'var(--hint)' }}>кадр на {d.cover.toFixed(1)} с</span>
                </div>
              </div>
              <button className="btn sec mt-3" onClick={() => { upd((n) => { n.cover = Math.round(t * 10) / 10 }); setToast(`Обкладинка — кадр на ${t.toFixed(1)} с`) }}>
                Зробити обкладинкою цей кадр
              </button>
            </div>
          </>
        )}
      </div>

      <div className="bbar">
        {dirty ? (
          <>
            <button className="btn sec" onClick={reset}>Скинути</button>
            <button className="btn" onClick={() => save('Збережено')}>Зберегти</button>
          </>
        ) : d.status === 'approved' ? (
          <>
            <button className="btn sec" onClick={() => { upd((n) => { n.status = 'ready_for_review' }); saveDemoVideo({ ...d, status: 'ready_for_review' }); setSaved(JSON.stringify({ ...d, status: 'ready_for_review' })) }}>Повернути на перегляд</button>
            <button className="btn" onClick={onBack}>Далі</button>
          </>
        ) : (
          <>
            <button className="btn sec" onClick={onBack}>Пізніше</button>
            <button className="btn" onClick={approve}>Затвердити</button>
          </>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

// ───────────── Прев'ю 9:16: відео + шар 1080×1920, масштабований під ширину ─────────────

type PreviewProps = {
  d: VideoDraft
  t: number
  sel: string | null
  small: boolean
  vref: React.RefObject<HTMLVideoElement | null>
  onSelect: (id: string) => void
  onMove: (id: string, y: number) => void
  onTap: () => void
}

function Preview({ d, t, sel, small, vref, onSelect, onMove, onTap }: PreviewProps) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(280)
  const drag = useRef<{ id: string; y0: number; py: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const k = w / VW

  const down = (e: RPointerEvent, x: VText) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { id: x.id, y0: x.y, py: e.clientY, moved: false }
  }
  const move = (e: RPointerEvent) => {
    const g = drag.current
    if (!g) return
    const dy = (e.clientY - g.py) / k
    if (Math.abs(dy) > 12) g.moved = true
    if (g.moved) onMove(g.id, Math.round(Math.max(SAFE_TOP, Math.min(SAFE_BOTTOM - 120, g.y0 + dy))))
  }
  const up = (e: RPointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    e.stopPropagation()
    if (!g.moved) { haptic('select'); onSelect(g.id) }
  }

  return (
    <div className="mx-auto" style={{ maxWidth: small ? 170 : 300, transition: 'max-width .2s' }}>
      <div ref={box} className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: '9 / 16', background: '#000', boxShadow: 'var(--shadow)' }} onClick={onTap}>
        <video ref={vref} src={d.video} poster={d.poster} className="absolute inset-0 h-full w-full object-cover" muted playsInline autoPlay loop preload="auto" />
        <div className="absolute top-0 left-0" style={{ width: VW, height: VH, transform: `scale(${k})`, transformOrigin: '0 0' }} onPointerMove={move} onPointerUp={up}>
          {d.texts.map((x) => {
            const { t0, t1 } = textTimes(d, x)
            const op = x.id === sel ? 1 : opacity(t, t0, t1, d.dur)
            if (op <= 0) return null
            return <TextBlock key={x.id} x={x} op={op} selected={x.id === sel} onDown={(e) => down(e, x)} />
          })}
          {d.wm.kind !== 'off' && <Watermark kind={d.wm.kind} pos={d.wm.pos} color={d.wm.color} />}
          {/* safe zone сторіз: тут Instagram кладе свої кнопки — показуємо, лише коли редагуємо */}
          {sel && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: SAFE_TOP, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.08) 0 18px, transparent 18px 36px)', borderBottom: '3px dashed rgba(255,255,255,.35)' }} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: VH - SAFE_BOTTOM, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.08) 0 18px, transparent 18px 36px)', borderTop: '3px dashed rgba(255,255,255,.35)' }} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function opacity(t: number, t0: number, t1: number, dur: number) {
  if (t < t0 || t > t1) return 0
  const a = Math.min(1, (t - t0) / FADE)
  const b = t1 >= dur - 0.05 ? 1 : Math.min(1, (t1 - t) / FADE)
  return Math.max(0, Math.min(a, b))
}

function TextBlock({ x, op, selected, onDown }: { x: VText; op: number; selected: boolean; onDown: (e: RPointerEvent) => void }) {
  const a = x.scrim
  return (
    <div
      className="absolute"
      style={{ top: x.y, left: 90, width: 900, opacity: op, textAlign: 'center', touchAction: 'none', cursor: 'grab' }}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
    >
      {a > 0 && (
        // м'яка смуга затемнення ±150px навколо тексту, на всю ширину кадру (як scrim у stories.py)
        <div
          className="pointer-events-none absolute"
          style={{ left: -90, right: -90, top: -150, bottom: -150, zIndex: -1, background: `linear-gradient(to bottom, transparent 0, rgba(0,0,0,${a * 0.35}) 75px, rgba(0,0,0,${a}) 150px, rgba(0,0,0,${a}) calc(100% - 150px), rgba(0,0,0,${a * 0.35}) calc(100% - 75px), transparent 100%)` }}
        />
      )}
      <div style={{ outline: selected ? '4px dashed rgba(255,255,255,.85)' : 'none', outlineOffset: 18, borderRadius: 8 }}>
        {x.lines.map((l, i) => <Line key={i} l={l} gap={lineGap(x.lines[i - 1], l)} />)}
      </div>
    </div>
  )
}

function Line({ l, gap }: { l: VLine; gap: number }) {
  const st = STYLES[l.style]
  const f = FONT[st.font]
  const gold = new Set(l.gold)
  return (
    <div
      style={{
        marginTop: gap, marginInline: 'auto', maxWidth: l.maxW ?? 900,
        fontFamily: f.family, fontSize: st.size, lineHeight: f.lh, letterSpacing: st.track,
        textTransform: st.upper ? 'uppercase' : 'none', color: st.gold ? GOLD : '#fff',
        textShadow: '0 4px 7px rgba(0,0,0,.75)', whiteSpace: 'normal', wordBreak: 'normal',
      }}
    >
      {words(l.text).map((w, i) => (
        <span key={i} style={gold.has(i) ? { color: GOLD } : undefined}>{i ? ' ' : ''}{w}</span>
      ))}
    </div>
  )
}

function Watermark({ kind, pos, color }: { kind: Exclude<WmKind, 'off'>; pos: WmPos; color: 'white' | 'gold' }) {
  const b = wmBox(kind, pos)
  return (
    <img
      src={WM[kind].src}
      alt=""
      className="pointer-events-none absolute"
      style={{
        left: b.x, top: b.y, width: b.w, height: b.h, objectFit: 'contain', opacity: 0.88,
        filter: `${color === 'white' ? 'brightness(0) invert(1) ' : ''}drop-shadow(0 2px 4px rgba(0,0,0,.6))`,
      }}
    />
  )
}

// ───────────── Таймлайн: смуга з межами кадрів ─────────────

function Timeline({ d, t, playing, small, onPlay, onSeek }: { d: VideoDraft; t: number; playing: boolean; small: boolean; onPlay: () => void; onSeek: (s: number) => void }) {
  const bar = useRef<HTMLDivElement>(null)
  const seekAt = (e: RPointerEvent) => {
    const r = bar.current?.getBoundingClientRect()
    if (r) onSeek(((e.clientX - r.left) / r.width) * d.dur)
  }
  return (
    <div className="mx-auto mt-2.5 flex items-center gap-2.5" style={{ maxWidth: small ? 240 : 300 }}>
      <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--bg2)' }} onClick={onPlay} aria-label={playing ? 'Пауза' : 'Грати'}>
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>
        )}
      </button>
      <div ref={bar} className="relative h-7 flex-1 touch-none" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seekAt(e) }} onPointerMove={(e) => { if (e.buttons) seekAt(e) }}>
        <div className="absolute inset-x-0 top-1/2 flex h-[6px] -translate-y-1/2 gap-[3px]">
          {d.shots.map((s, i) => {
            const end = i < d.shots.length - 1 ? d.shots[i + 1].t0 : d.dur
            return <i key={i} className="block h-full rounded-full" style={{ flex: end - s.t0, background: 'color-mix(in srgb, var(--hint) 30%, transparent)' }} />
          })}
        </div>
        <div className="absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full" style={{ left: `${(t / d.dur) * 100}%`, background: 'var(--text)' }} />
      </div>
      <span className="w-9 text-right text-[12px] tabular-nums" style={{ color: 'var(--hint)' }}>{t.toFixed(1)}с</span>
    </div>
  )
}

// ───────────── Редактор одного тексту ─────────────

function TextEditor({ d, x, onChange, onRemove }: { d: VideoDraft; x: VText; onChange: (fn: (x: VText) => void) => void; onRemove: () => void }) {
  const toggleShot = (i: number) => {
    haptic('select')
    onChange((q) => {
      // кадри — суцільний діапазон: тап за межами розширює, тап по краю звужує
      if (i < q.from) q.from = i
      else if (i > q.to) q.to = i
      else if (q.from === q.to) return
      else if (i === q.from) q.from++
      else if (i === q.to) q.to--
      else { q.from = i; q.to = i }
    })
  }
  return (
    <div className="card mt-3">
      {x.lines.map((l, i) => (
        <div key={i} className="mb-3 pb-3" style={{ borderBottom: '.5px solid var(--line)' }}>
          <div className="flex items-center gap-2">
            <input className="in flex-1" style={{ height: 40 }} value={l.text} onChange={(e) => onChange((q) => {
              q.lines[i].text = e.target.value
              q.lines[i].gold = q.lines[i].gold.filter((g) => g < words(e.target.value).length)
            })} />
            {x.lines.length > 1 && (
              <button className="h-10 w-9 shrink-0 text-[18px]" style={{ color: 'var(--hint)' }} aria-label="Прибрати рядок" onClick={() => onChange((q) => { q.lines.splice(i, 1) })}>✕</button>
            )}
          </div>
          <div className="qchips">
            {(Object.keys(STYLES) as LineStyle[]).map((s) => (
              <button key={s} className={l.style === s ? 'on' : ''} onClick={() => onChange((q) => { q.lines[i].style = s })}>{STYLES[s].name}</button>
            ))}
          </div>
          {!STYLES[l.style].gold && words(l.text).length > 1 && (
            <>
              <div className="mt-2 text-[12.5px]" style={{ color: 'var(--hint)' }}>Золотом — торкнись слова:</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {words(l.text).map((w, wi) => {
                  const on = l.gold.includes(wi)
                  return (
                    <button key={wi} className="rounded-md px-2 py-0.5 text-[14px]" style={{ background: on ? GOLD : 'var(--bg2)', color: on ? '#2A211B' : 'var(--text)' }}
                      onClick={() => onChange((q) => { const g = q.lines[i].gold; q.lines[i].gold = on ? g.filter((z) => z !== wi) : [...g, wi] })}>{w}</button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      ))}
      <button className="text-[14px] font-medium" style={{ color: 'var(--accent)' }} onClick={() => onChange((q) => { q.lines.push({ text: 'Ще рядок', style: 'sub', gold: [] }) })}>＋ Рядок</button>

      <div className="mt-4 text-[13px] font-semibold">Де на екрані</div>
      <div className="qchips" style={{ marginTop: 6 }}>
        {POS.map((p) => <button key={p.name} className={Math.abs(x.y - p.y) < 60 ? 'on' : ''} onClick={() => onChange((q) => { q.y = p.y })}>{p.name}</button>)}
      </div>
      <div className="mt-4 text-[13px] font-semibold">На яких кадрах</div>
      <div className="qchips" style={{ marginTop: 6 }}>
        {d.shots.map((s, i) => (
          <button key={i} className={i >= x.from && i <= x.to ? 'on' : ''} onClick={() => toggleShot(i)}>{i + 1} · {s.label}</button>
        ))}
      </div>
      <div className="mt-4 text-[13px] font-semibold">Затемнення під текстом</div>
      <div className="seg mt-1.5" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {SCRIM.map((s) => <button key={s.name} className={Math.abs(x.scrim - s.a) < 0.1 || (s.a === 0.28 && x.scrim > 0.1 && x.scrim < 0.4) ? 'on' : ''} onClick={() => onChange((q) => { q.scrim = s.a })}>{s.name}</button>)}
      </div>
      <button className="mt-4 text-[14px]" style={{ color: 'var(--bad)' }} onClick={onRemove}>Прибрати цей текст</button>
    </div>
  )
}

// ───────────── Водяний знак ─────────────

function WmEditor({ d, onChange }: { d: VideoDraft; onChange: (fn: (x: VideoDraft) => void) => void }) {
  const kinds: WmKind[] = ['wm2', 'wm1', 'wm3', 'off']
  return (
    <div className="card mt-3">
      <div className="text-[13px] font-semibold">Який знак</div>
      <div className="seg mt-1.5" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {kinds.map((k) => <button key={k} className={d.wm.kind === k ? 'on' : ''} onClick={() => { haptic('select'); onChange((n) => { n.wm.kind = k }) }}>{k === 'off' ? 'Без' : WM[k].name}</button>)}
      </div>
      {d.wm.kind !== 'off' && (
        <>
          <div className="mt-4 text-[13px] font-semibold">Де</div>
          <div className="qchips" style={{ marginTop: 6 }}>
            {WM_POS.map((p) => <button key={p.id} className={d.wm.pos === p.id ? 'on' : ''} onClick={() => onChange((n) => { n.wm.pos = p.id })}>{p.name}</button>)}
          </div>
          <div className="mt-4 text-[13px] font-semibold">Колір</div>
          <div className="seg mt-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className={d.wm.color === 'white' ? 'on' : ''} onClick={() => onChange((n) => { n.wm.color = 'white' })}>Білий</button>
            <button className={d.wm.color === 'gold' ? 'on' : ''} onClick={() => onChange((n) => { n.wm.color = 'gold' })}>Золотий</button>
          </div>
          <div className="mt-3 text-[12.5px] leading-snug" style={{ color: 'var(--hint)' }}>
            Для сторіз радимо коло внизу праворуч. Якщо внизу буде стікер-опитування — переклади знак вгору.
          </div>
        </>
      )}
    </div>
  )
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s)

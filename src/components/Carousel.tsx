import { useEffect, useRef, useState } from 'react'
import type { MediaView } from '../lib/api'

const GRADIENTS = [
  'linear-gradient(160deg,#9fc3c9,#2f6f7a)',
  'linear-gradient(160deg,#e5d3b3,#a07a4c)',
  'linear-gradient(160deg,#b9cfb0,#4f7d57)',
  'linear-gradient(160deg,#d8c3d6,#7a5a78)',
]

// Карусель як у мокапі: біла рамка, 4:5, лічильник і крапки. onSlide — який слайд зараз видно (для «Інша фотка»).
// ready — готові файли з сервера (рамка + обробка + текст уже на фото): показуємо їх як є, без своєї рамки й обрізу
export function Carousel({ ids, media, onSlide, start = 0, ready }: { ids: string[]; media: Record<string, MediaView>; onSlide?: (i: number) => void; start?: number; ready?: (string | null)[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [cur, setCur] = useState(Math.min(start, Math.max(0, ids.length - 1)))

  // Після заміни фото лишаємось на тому ж слайді, а не стрибаємо на перший
  useEffect(() => {
    const el = ref.current
    if (!el || !cur || !el.firstElementChild) return
    el.scrollLeft = cur * ((el.firstElementChild as HTMLElement).offsetWidth + 10)
    // лише при монтуванні
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const solo = ids.length === 1

  const onScroll = () => {
    const el = ref.current
    if (!el || !el.firstElementChild) return
    const w = (el.firstElementChild as HTMLElement).offsetWidth + 10
    const i = Math.min(ids.length - 1, Math.max(0, Math.round(el.scrollLeft / w)))
    if (i !== cur) {
      setCur(i)
      onSlide?.(i)
    }
  }

  return (
    <>
      <div ref={ref} className="car" onScroll={onScroll}>
        {ids.map((id, i) => {
          const m = media[id]
          const done = ready?.[i]
          if (done) {
            return (
              <div key={`${id}-${i}`} className={`slide ready${solo ? ' solo' : ''}`}>
                <div className="ph">
                  <img src={done} alt={m?.description ?? ''} loading={i ? 'lazy' : 'eager'} />
                  {!solo && <span className="n">{i + 1}/{ids.length}</span>}
                </div>
              </div>
            )
          }
          return (
            <div key={`${id}-${i}`} className={`slide${solo ? ' solo' : ''}`}>
              <div className="ph" style={m?.url ? undefined : { background: GRADIENTS[i % GRADIENTS.length] }}>
                {m?.url ? <img src={m.url} alt={m.description ?? ''} loading={i ? 'lazy' : 'eager'} /> : <span className="ph-empty">{m?.description ?? 'фото'}</span>}
                {!solo && <span className="n">{i + 1}/{ids.length}</span>}
              </div>
            </div>
          )
        })}
      </div>
      {!solo && (
        <div className="dots">{ids.map((id, i) => <i key={`${id}-${i}`} className={i === cur ? 'on' : ''} />)}</div>
      )}
    </>
  )
}

import type { Plan } from './api'

// «Про що цей пост і для кого»: з note слоту (WF-018, портрети Audience_Strategy_v3) + pillar.
// note: «Для кого: P3 Жінки в подорожі (дві подруги…). Питання клієнта: «…» — відповідай… <службове>»
export type Audience = { persona: string | null; who: string | null; question: string | null; topic: string }

const TOPIC: Record<string, string> = {
  hotel_place: 'Готель: чим він цінний', insider: 'Інсайдер про готель', tour_offer: 'Пропозиція (тур / ціна)', tour_offer_fallback: 'Пропозиція',
  tour_offer_seasonal: 'Сезонна пропозиція', tour_expert: 'Експертна думка', personal_take: 'Думка Іри', personal: 'Особисте', personal_experience: 'Історія Іри',
  behind_scenes: 'За кадром', video: 'Відео', template: 'Сторіз за шаблоном', unusual_hotels: 'Рубрика «Незвичайні готелі»', atmosphere: 'Атмосфера',
}

export function audienceOf(p: Pick<Plan, 'note' | 'pillar'>): Audience {
  const note = p.note ?? ''
  const m = /Для кого:\s*(P\d)\s+([^(.]+?)\s*\(([^)]*)\)/.exec(note)
  const q = /Питання клієнта:\s*«([^»]+)»/.exec(note)
  return {
    persona: m ? m[2].trim() : null,
    who: m ? m[3].trim() : null,
    question: q ? q[1].trim() : null,
    topic: TOPIC[p.pillar] ?? p.pillar,
  }
}

// Формат публікації: що саме підемо викладати
export function formatOf(p: Pick<Plan, 'platform' | 'slot_type'>, photos = 0): string {
  if (p.slot_type === 'reel') return 'Рілс (відео)'
  if (p.slot_type === 'stories') return 'Сторіз'
  if (p.platform === 'threads') return 'Тред (текст)'
  if (photos > 1) return `Карусель · ${photos} фото`
  if (photos === 1) return 'Пост з фото'
  return p.slot_type === 'feed_carousel' ? 'Карусель' : 'Пост з фото'
}

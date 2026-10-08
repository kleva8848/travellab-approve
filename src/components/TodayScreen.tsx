import type { Me } from '../lib/api'
import { Label } from './ui'

const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота']
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня']

function greeting(h: number) {
  if (h < 5) return 'Доброї ночі'
  if (h < 12) return 'Доброго ранку'
  if (h < 18) return 'Доброго дня'
  return 'Доброго вечора'
}

// Звертання в кличному відмінку для відомих імен, інакше як є
const VOCATIVE: Record<string, string> = { 'Іра': 'Іро', 'Ira': 'Іро', 'Ірина': 'Ірино', 'Влад': 'Владе', 'Vlad': 'Владе' }

// Фаза 1: каркас. Черга постів (фаза 3), питання (фаза 4) і «сьогодні публікуємо» (фаза 5) з'являться тут
export function TodayScreen({ me }: { me: Me }) {
  const now = new Date()
  const day = DAYS[now.getDay()]
  const name = me.first_name ? VOCATIVE[me.first_name] ?? me.first_name : null
  return (
    <div className="px-4 pt-3.5 pb-6">
      <div className="text-[13px]" style={{ color: 'var(--hint)' }}>
        {day[0].toUpperCase() + day.slice(1)}, {now.getDate()} {MONTHS[now.getMonth()]}
      </div>
      <h1 className="serif mt-1.5 mb-0.5 text-[32px] leading-[1.05]">
        {greeting(now.getHours())}{name ? `, ${name}` : ''}
      </h1>
      <div className="mb-4 text-[13px]" style={{ color: 'var(--hint)' }}>Тут лише те, що чекає на тебе. Решту агент робить сам.</div>

      <div className="card text-center">
        <div className="serif text-[22px]">Скоро тут будуть пости</div>
        <div className="mt-1 text-[13.5px] leading-snug" style={{ color: 'var(--hint)' }}>
          Щоранку агент готуватиме пости на завтра й післязавтра — по одному, з фото. Ти переглядаєш, правиш або затверджуєш.
        </div>
      </div>

      <Label>Що буде в застосунку</Label>
      <div className="card text-[14px] leading-relaxed">
        {['Пости на перегляд — по одному, з готовим фото', 'Правки окремо до тексту і до фото', 'Питання про готель — тапом, текстом або голосом', 'Календар Telegram / Instagram / Threads'].map((t) => (
          <div key={t} className="flex gap-2.5 py-1">
            <span style={{ color: 'var(--accent)' }}>·</span>
            {t}
          </div>
        ))}
      </div>
    </div>
  )
}

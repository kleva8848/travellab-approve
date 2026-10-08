// Фаза 5: календар TG / IG / Threads з ручною публікацією. Поки — порожній стан
export function CalendarScreen() {
  return (
    <div className="px-4 pt-3.5 pb-6">
      <h1 className="serif mt-1.5 mb-3 text-[28px]">Календар</h1>
      <div className="card text-center">
        <div className="text-[14px] leading-snug" style={{ color: 'var(--hint)' }}>
          Тут будуть затверджені пости по днях і платформах — з кнопками «Копіювати текст» і «Зберегти фото».
        </div>
      </div>
    </div>
  )
}

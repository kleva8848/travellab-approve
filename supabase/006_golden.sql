-- TravelLab Approve · 006 · ⭐ «найкращий» пост (golden, 09.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.

-- Зірка стоїть на конкретній версії тексту — саме її генератор потім братиме за приклад (few-shot за платформою)
alter table public.post_versions
  add column if not exists is_golden boolean not null default false,
  add column if not exists golden_at timestamptz;

create index if not exists post_versions_golden_idx on public.post_versions (golden_at desc) where is_golden;

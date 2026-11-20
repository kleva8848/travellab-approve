-- TravelLab Approve · 026 · «Пост виклала?» (сет 1 правок Іри, 21.11)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.
--
-- Бот (WF-050) у день публікації о 21:00 і наступного ранку о 10:00 питає Іру «Пост «…» — виклала?»
-- [✅ Виклала] [📅 На завтра] [⏭ Не буду]. publish_ask = «<дата слоту>:eve|morn» — на цей етап уже питали (не повторюємо кожні 5 хв).
-- Статус 'missed' уже є в content_plan_review_status_check (002) — апка сама ставить його затвердженим постам,
-- чия дата минула понад 2 дні; у Календарі вони в блоці «Не вийшли» з кнопкою «Повернути».

alter table public.content_plan
  add column if not exists publish_ask text;

notify pgrst, 'reload schema';

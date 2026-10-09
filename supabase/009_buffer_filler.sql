-- TravelLab Approve · 009 · Buffer Filler D+3 (09.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.
-- Без цього файлу Buffer Filler теж працює: версію пише з trigger='initial' (+ prompt_version 'buffer_filler').

-- нове джерело версії: 'buffer_filler' (ранкове заповнення буфера на 3 дні вперед)
alter table public.post_versions drop constraint if exists post_versions_trigger_check;
alter table public.post_versions add constraint post_versions_trigger_check check (trigger in (
  'initial', 'comment', 'data_answer', 'photo_edit', 'own_photo', 'manual', 'backfill', 'buffer_filler'
));

-- щоб не питати Іру двічі про те саме (пошук відкритих запитів за готелем/туром/полем)
create index if not exists data_requests_subject_idx on public.data_requests (status, field, hotel_id, tour_id);

notify pgrst, 'reload schema';

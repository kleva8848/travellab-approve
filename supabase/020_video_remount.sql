-- TravelLab Approve · 020 · сторіз і рілс: перемонтаж кадрів з апки (сет 4, 26.10)
-- Запуск: Supabase → SQL Editor → Run (після 018 + 019). Повторний запуск безпечний (if not exists).
--
-- Іра на вкладці «Кадри»: прибрати / інший кадр / порядок / коротше → /api/video action 'remount' кладе заявку в remount →
-- воркер на Mac (montage-test/remount_worker.py, крутиться разом з final_worker.py --loop) монтує нове чисте відео
-- з оригіналів (stories.py --clean) → нові clean/web/poster/мініатюри у <slug>/rN/ → shots, dur, *_path, тексти переназначені.
-- Одна заявка на відео за раз — окрема таблиця не потрібна.

alter table public.video_drafts
  -- заявка: {kind: remove|replace|reorder|shorter, shot?, order?, state: queued|running|done|error, at, by, error?, note?}
  -- state=done + note — що змінилось у текстах (апка показує один раз); null — заявок не було
  add column if not exists remount jsonb,
  -- звідки монтувати: {inbox: 'reels/inbox' (відносно montage-test), xfade: 0.4, rev: 0}; rev — номер версії файлів (<slug>/rN/)
  add column if not exists montage jsonb not null default '{}';

-- shots[] тепер ще й з параметрами шоту з плану stories.py: start, dur, speed, crop_x, crop_y, fit (upload_drafts.py)

-- черга воркера
create index if not exists video_drafts_remount_idx on public.video_drafts ((remount ->> 'state')) where remount is not null;

notify pgrst, 'reload schema';

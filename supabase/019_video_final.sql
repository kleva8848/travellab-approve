-- TravelLab Approve · 019 · сторіз і рілс: фінальний рендер (сет 3, 24.10)
-- Запуск: Supabase → SQL Editor → Run (після 018). Повторний запуск безпечний (if not exists).
--
-- Воркер на Mac (montage-test/final_worker.py) бере video_drafts status=approved без final_path →
-- шари (satori, той самий layout, що прев'ю) поверх clean.mp4 → <slug>/final.mp4 + <slug>/cover.jpg → бот шле в чат тому, хто затвердив.
-- Будь-яка правка / «Повернути» / повторне «Затвердити» в апці чистить final_* → воркер рендерить заново.

alter table public.video_drafts
  add column if not exists final_path   text,          -- <slug>/final.mp4 — 1080×1920 з текстом і знаком
  add column if not exists cover_path   text,          -- <slug>/cover.jpg — кадр plan.cover з фіналу
  add column if not exists rendered_at  timestamptz,
  add column if not exists render_error text,          -- остання помилка воркера (рендер / відправка) — видно Владу
  add column if not exists tg_file_id   text,          -- file_id з першої відправки → «Надіслати ще раз» без повторного завантаження
  add column if not exists sent_at      timestamptz,
  add column if not exists sent_to      bigint;        -- TG ID, кому надіслали останній раз

-- черга воркера
create index if not exists video_drafts_render_idx on public.video_drafts (approved_at) where status = 'approved' and final_path is null;

notify pgrst, 'reload schema';

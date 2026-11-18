-- TravelLab Approve · 025 · окрема обкладинка рілс / сторіз (сет 1 «Чиста обкладинка», 18.11)
-- Запуск: Supabase → SQL Editor → Run (після 018–024). Повторний запуск безпечний (if not exists).
--
-- Раніше обкладинка = кадр із final.mp4 (там уже випалені субтитри й знак). Тепер воркер бере чистий кадр із clean.mp4
-- + заголовок + знак (той самий satori, що шари відео) → cover.jpg.

alter table public.video_drafts
  -- що намальовано: {bg: {kind: 'frame'|'media', t?: секунди clean.mp4, media_id?}, kicker, title ("*золоте* слово"), wm: {kind,pos,color}|{kind:'off'}}
  -- null — воркер візьме найрізкіший кандидат + заголовок із плану. plan.cover (число секунд) лишається фолбеком.
  add column if not exists cover_spec jsonb,
  -- кадри-кандидати БЕЗ текстів, найрізкіші першими: [{path: '<slug>/cands/c1.jpg', t: секунди, sharp: оцінка}] (до 6)
  add column if not exists cover_cands jsonb;

notify pgrst, 'reload schema';

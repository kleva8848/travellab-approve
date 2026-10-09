-- TravelLab · 010 · рубрика «Незвичайні готелі» (pillar 'unusual_hotels') у content_plan — WF-018, 09.10
-- DDL content_plan у репо/vault не знайдено; у живих даних pillar лише 12 «старих» значень, тож CHECK на pillar
-- може бути. Цей скрипт безпечний у будь-якому випадку: прибирає CHECK-обмеження content_plan, що стосуються
-- pillar або slot_type (pillar — вільний текст за задумом: story_queue.pillar іде в план як є).
-- Якщо таких обмежень нема — нічого не робить. Повторний запуск безпечний.
-- Запуск: Supabase → SQL Editor → Run.
do $$
declare c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.content_plan'::regclass
      and contype = 'c'
      and (pg_get_constraintdef(oid) ilike '%pillar%' or pg_get_constraintdef(oid) ilike '%slot_type%')
  loop
    raise notice 'drop % : %', c.conname, c.def;
    execute format('alter table public.content_plan drop constraint %I', c.conname);
  end loop;
end $$;

-- Перевірка (має повернути 0 рядків):
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.content_plan'::regclass and contype = 'c'
--   and (pg_get_constraintdef(oid) ilike '%pillar%' or pg_get_constraintdef(oid) ilike '%slot_type%');

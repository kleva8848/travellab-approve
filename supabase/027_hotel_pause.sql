-- TravelLab Approve · 027 · Пауза готелів + пропуск будь-якого поста (сет 3 правок Іри, 20.11)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.
--
-- Пауза = hotels.status 'Inactive' (WF-018 бере лише status='Active' — на паузі готель у план не потрапляє).
-- Повернути = 'Active'. Готелі зі статусом needs_review апка не чіпає (їх активує WF-055 після перевірки).
-- tl_pause_hotel: готель → Inactive + майбутні ненаписані слоти (planned / needs_data без тексту) → skipped.
--   Написані пости (на перегляді / затверджені) не чіпаємо — Іра вирішує сама.
-- tl_resume_hotel: готель → Active + повертає в planned ті слоти, що пропустила саме пауза (skip_reason = 'готель на паузі').

alter table public.hotels
  add column if not exists paused_at timestamptz;

alter table public.content_plan
  add column if not exists skip_reason  text,
  add column if not exists skipped_from text;   -- статус до пропуску: «Повернути» вертає його

create or replace function public.tl_pause_hotel(p_hotel_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text;
  v_skipped int;
begin
  update public.hotels
     set status = 'Inactive', paused_at = now()
   where hotel_id = p_hotel_id
     and status in ('Active', 'Inactive')
  returning name into v_name;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  with s as (
    update public.content_plan
       set skipped_from  = review_status,
           review_status = 'skipped',
           skip_reason   = 'готель на паузі',
           review_note   = 'готель на паузі',
           updated_at    = now()
     where hotel_id = p_hotel_id
       and published_at is null
       and (scheduled_for is null or scheduled_for >= current_date)
       and (review_status = 'planned' or (review_status = 'needs_data' and current_version_id is null))
    returning id
  )
  select count(*) into v_skipped from s;

  -- відкриті питання Іри по цих слотах більше не потрібні
  update public.data_requests
     set status = 'dismissed'
   where status = 'open'
     and content_plan_id in (select id from public.content_plan where hotel_id = p_hotel_id and review_status = 'skipped' and skip_reason = 'готель на паузі');

  return jsonb_build_object('ok', true, 'name', v_name, 'skipped', v_skipped);
end $$;

create or replace function public.tl_resume_hotel(p_hotel_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text;
  v_restored int;
begin
  update public.hotels
     set status = 'Active', paused_at = null
   where hotel_id = p_hotel_id
     and status = 'Inactive'
  returning name into v_name;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  with r as (
    update public.content_plan
       set review_status = 'planned',
           skip_reason   = null,
           skipped_from  = null,
           review_note   = null,
           updated_at    = now()
     where hotel_id = p_hotel_id
       and review_status = 'skipped'
       and skip_reason = 'готель на паузі'
       and published_at is null
       and (scheduled_for is null or scheduled_for >= current_date)
    returning id
  )
  select count(*) into v_restored from r;

  return jsonb_build_object('ok', true, 'name', v_name, 'restored', v_restored);
end $$;

grant execute on function public.tl_pause_hotel(text)  to service_role;
grant execute on function public.tl_resume_hotel(text) to service_role;

notify pgrst, 'reload schema';

-- Перевірка (нічого не міняє): які готелі зараз Active / Inactive
-- select status, count(*) from public.hotels group by status;

-- TravelLab Approve · 004 · фото в пості з наявних (Фаза 6a, 2026-10-08)
-- Потрібна 002. Запуск: Supabase → SQL Editor → Run (повторний запуск безпечний).
-- Фото лежать у Drive (media.drive_file_id); n8n WF-047 копіює зменшену версію (~1600px) у Storage `post-media`,
-- апка показує їх через signed URL. Підбір фото — детермінований SQL, без LLM.

-- ───────────── сховище (приватне: доступ лише через service role / signed URL) ─────────────
insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', false)
on conflict (id) do nothing;

-- ───────────── media: стан копії в Storage ─────────────
alter table public.media
  add column if not exists storage_path  text,
  add column if not exists synced_at     timestamptz,
  add column if not exists sync_error    text,
  add column if not exists width         integer,
  add column if not exists height        integer,
  add column if not exists last_used_at  timestamptz;

create index if not exists media_hotel_ready_idx on public.media (hotel_id) where storage_path is not null;

-- URL проєкту для n8n (Storage API). Не секрет; при переносі на акаунт Іри — нове значення тут
insert into public.settings (key, value, note) values
  ('supabase_url', to_jsonb('https://vimwbhkmdlffmfheaswh.supabase.co'::text), 'URL проєкту Supabase — n8n вантажить фото в Storage за цією адресою')
on conflict (key) do nothing;

-- ───────────── скільки фото потрібно слоту ─────────────
-- IG-карусель = 3, звичайний пост = 1, відео/рілс/сторіз = 0 (там своє відео, фото не підставляємо)
create or replace function public.tl_photo_count(p_platform text, p_slot_type text, p_pillar text)
returns integer language sql immutable as $$
  select case
    when p_pillar in ('video', 'template') or p_slot_type in ('reel', 'stories') then 0
    when p_platform = 'instagram' and p_slot_type like '%carousel%' then 3
    else 1
  end
$$;

-- ───────────── підбір фото ─────────────
-- Фото готелю поста, вже скопійовані в Storage; спершу ті, що не стоять в інших активних постах,
-- далі найменш використані й найдавніше використані. p_exclude — що не брати (поточні фото при заміні).
create or replace function public.tl_pick_media(p_plan_id uuid, p_count integer, p_exclude text[] default '{}')
returns text[]
language sql stable
set search_path = public
as $$
  with plan as (select hotel_id from content_plan where id = p_plan_id),
  busy as (
    select distinct unnest(v.media_ids) as media_id
    from content_plan cp
    join post_versions v on v.id = cp.current_version_id
    where cp.id <> p_plan_id
      and cp.review_status in ('ready_for_review', 'changes_requested', 'regenerating', 'needs_data', 'approved')
  )
  select coalesce(array_agg(media_id), '{}') from (
    select m.media_id
    from media m, plan
    where m.hotel_id = plan.hotel_id
      and m.storage_path is not null
      and coalesce(m.type, 'photo') = 'photo'
      and not (m.media_id = any(coalesce(p_exclude, '{}')))
    order by (m.media_id in (select media_id from busy)), m.usage_count nulls first, m.last_used_at nulls first, random()
    limit greatest(p_count, 0)
  ) picked
$$;

-- ───────────── підставити / замінити фото → нова версія (текст той самий) ─────────────
-- p_slide = null: підібрати всі фото заново (авто-заповнення); p_slide = N: замінити лише N-те фото (0-based).
-- Повертає нову версію або null, якщо змінювати нічого (нема фото готелю / слоту фото не потрібні).
create or replace function public.tl_attach_photos(p_plan_id uuid, p_expected_version_no integer, p_slide integer default null)
returns public.post_versions
language plpgsql
set search_path = public
as $$
declare
  cp    content_plan;
  cur   post_versions;
  need  integer;
  ids   text[];
  fresh text[];
begin
  select * into cp from content_plan where id = p_plan_id;
  if not found then raise exception 'content_plan % not found', p_plan_id; end if;
  select * into cur from post_versions where id = cp.current_version_id;
  need := tl_photo_count(cp.platform, cp.slot_type, cp.pillar);
  if need = 0 or cp.hotel_id is null then return null; end if;
  ids := coalesce(cur.media_ids, '{}');

  if p_slide is null then
    fresh := tl_pick_media(p_plan_id, need, '{}');
    if cardinality(fresh) = 0 or fresh = ids then return null; end if;
    ids := fresh;
  else
    fresh := tl_pick_media(p_plan_id, 1, ids);
    if cardinality(fresh) = 0 then return null; end if;
    if p_slide + 1 > cardinality(ids) then ids := ids || fresh[1];
    else ids[p_slide + 1] := fresh[1];
    end if;
  end if;

  return tl_add_version(
    p_content_plan_id     => p_plan_id,
    p_text                => null,
    p_trigger             => 'photo_edit',
    p_expected_version_no => p_expected_version_no,
    p_media_ids           => ids,
    p_prompt_version      => case when p_slide is null then 'auto-photos' else 'swap-photo' end,
    p_review_status       => cp.review_status
  );
end $$;

-- ───────────── фото затвердженого поста позначаємо використаними ─────────────
create or replace function public.tl_mark_media_used(p_plan_id uuid)
returns void
language sql
set search_path = public
as $$
  update media m
     set usage_count = coalesce(m.usage_count, 0) + 1, last_used_at = now()
    from content_plan cp
    join post_versions v on v.id = cp.current_version_id
   where cp.id = p_plan_id and m.media_id = any(v.media_ids)
$$;

revoke all on function public.tl_pick_media from public, anon, authenticated;
revoke all on function public.tl_attach_photos from public, anon, authenticated;
revoke all on function public.tl_mark_media_used from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.tl_pick_media to service_role;
    grant execute on function public.tl_attach_photos to service_role;
    grant execute on function public.tl_mark_media_used to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';

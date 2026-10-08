-- TravelLab Approve · 002 · схема поштучного апруву (Фаза 2, 2026-10-08)
-- Звірено з живою схемою Supabase «Travel Lab Test» 08.10 (content_plan, posts, hotels, tours, media).
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний (if not exists / or replace).
-- Старий content_plan.status (з CHECK для WF-018…021) не чіпаємо — апка живе на окремій колонці review_status.

-- ───────────────────────── content_plan: стан огляду ─────────────────────────
alter table public.content_plan
  add column if not exists scheduled_for      date,
  add column if not exists slot_time          time,
  add column if not exists review_status      text not null default 'planned',
  add column if not exists current_version_id uuid,
  add column if not exists version_no         integer not null default 0,
  add column if not exists approved_at        timestamptz,
  add column if not exists published_at       timestamptz,
  add column if not exists review_note        text;

-- planned → generating → needs_data → ready_for_review → changes_requested → regenerating → approved → published
-- skipped / missed / failed — кінцеві; backlog — старі чернетки Notion-епохи, не в черзі Іри
alter table public.content_plan drop constraint if exists content_plan_review_status_check;
alter table public.content_plan add constraint content_plan_review_status_check check (review_status in (
  'planned', 'generating', 'needs_data', 'ready_for_review', 'changes_requested', 'regenerating',
  'approved', 'published', 'skipped', 'missed', 'failed', 'backlog'
));

create index if not exists content_plan_review_idx on public.content_plan (review_status, scheduled_for);

-- ───────────────────────── post_versions: кожна версія поста ─────────────────────────
-- Лікує «Prev Text = найстаріша версія»: історія повна, окремі лічильники тексту і фото
create table if not exists public.post_versions (
  id               uuid primary key default gen_random_uuid(),
  content_plan_id  uuid not null references public.content_plan (id) on delete cascade,
  version_no       integer not null,
  text_v           integer not null default 1,
  image_v          integer not null default 0,
  text             text,
  hooks            text[],
  form             text,
  key_idea         text,
  media_ids        text[] not null default '{}',
  rendered_urls    text[] not null default '{}',
  render_params    jsonb not null default '{}'::jsonb,
  trigger          text not null default 'initial'
                   check (trigger in ('initial', 'comment', 'data_answer', 'photo_edit', 'own_photo', 'manual', 'backfill')),
  comment_id       uuid,
  model            text,
  prompt_version   text,
  lint             jsonb,
  missing_facts    jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  unique (content_plan_id, version_no)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'content_plan_current_version_fk') then
    alter table public.content_plan add constraint content_plan_current_version_fk
      foreign key (current_version_id) references public.post_versions (id) on delete set null;
  end if;
end $$;

-- ───────────────────────── review_comments: правки Іри ─────────────────────────
create table if not exists public.review_comments (
  id               uuid primary key default gen_random_uuid(),
  content_plan_id  uuid not null references public.content_plan (id) on delete cascade,
  version_id       uuid references public.post_versions (id) on delete set null,
  target           text not null default 'text' check (target in ('text', 'photo')),
  slide_idx        integer,
  body             text not null,
  chips            text[] not null default '{}',
  source           text not null default 'app' check (source in ('app', 'voice_bot', 'notion')),
  author_tg_id     bigint,
  parsed           jsonb,
  kind             text check (kind in ('one_off', 'style_rule', 'fact_correction')),
  status           text not null default 'new' check (status in ('new', 'processing', 'applied', 'dismissed', 'failed')),
  created_at       timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'post_versions_comment_fk') then
    alter table public.post_versions add constraint post_versions_comment_fk
      foreign key (comment_id) references public.review_comments (id) on delete set null;
  end if;
end $$;

create index if not exists review_comments_plan_idx on public.review_comments (content_plan_id, created_at);

-- ───────────────────────── data_requests: «бракує даних» ─────────────────────────
create table if not exists public.data_requests (
  id               uuid primary key default gen_random_uuid(),
  content_plan_id  uuid references public.content_plan (id) on delete cascade,
  hotel_id         text references public.hotels (hotel_id),
  tour_id          text references public.tours (tour_id),
  field            text,
  question         text not null,
  why_needed       text,
  options          text[] not null default '{}',
  answer           text,
  answered_via     text check (answered_via in ('text', 'button', 'voice_bot')),
  status           text not null default 'open' check (status in ('open', 'answered', 'applied', 'dismissed')),
  created_at       timestamptz not null default now(),
  answered_at      timestamptz
);

create index if not exists data_requests_open_idx on public.data_requests (status, content_plan_id);

-- ───────────────────────── ira_rules: чого навчились з правок ─────────────────────────
-- global — лише після ✅ Влада (рішення #9 плану)
create table if not exists public.ira_rules (
  id                 uuid primary key default gen_random_uuid(),
  rule_text          text not null,
  scope              text not null check (scope in ('global', 'platform', 'pillar', 'hotel')),
  scope_value        text,
  source_comment_id  uuid references public.review_comments (id) on delete set null,
  status             text not null default 'pending' check (status in ('pending', 'active', 'rejected')),
  registry_id        text,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         bigint,
  check (scope = 'global' or scope_value is not null)
);

-- ───────────────────────── render_prefs: «запам'ятати для готелю / всіх» ─────────────────────────
create table if not exists public.render_prefs (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope in ('global', 'platform', 'hotel', 'post')),
  scope_value  text not null default '',
  key          text not null,
  value        jsonb,
  updated_at   timestamptz not null default now(),
  unique (scope, scope_value, key)
);

-- ───────────────────────── атомарна нова версія (для n8n) ─────────────────────────
-- n8n кличе POST /rest/v1/rpc/tl_add_version. Перевіряє expected_version_no (захист від подвійних тапів/гонок),
-- пише версію, рухає current_version_id і review_status одним запитом.
create or replace function public.tl_add_version(
  p_content_plan_id     uuid,
  p_text                text,
  p_trigger             text default 'initial',
  p_expected_version_no integer default null,
  p_comment_id          uuid default null,
  p_hooks               text[] default null,
  p_form                text default null,
  p_key_idea            text default null,
  p_media_ids           text[] default null,
  p_rendered_urls       text[] default null,
  p_render_params       jsonb default null,
  p_model               text default null,
  p_prompt_version      text default null,
  p_lint                jsonb default null,
  p_missing_facts       jsonb default '[]'::jsonb,
  p_review_status       text default 'ready_for_review'
) returns public.post_versions
language plpgsql
set search_path = public
as $$
declare
  cp   public.content_plan;
  prev public.post_versions;
  v    public.post_versions;
  text_changed  boolean;
  image_changed boolean;
begin
  select * into cp from public.content_plan where id = p_content_plan_id for update;
  if not found then raise exception 'content_plan % not found', p_content_plan_id; end if;
  if p_expected_version_no is not null and cp.version_no <> p_expected_version_no then
    raise exception 'version_conflict: expected %, actual %', p_expected_version_no, cp.version_no using errcode = 'P0409';
  end if;

  select * into prev from public.post_versions where id = cp.current_version_id;
  text_changed  := prev.id is null or coalesce(p_text, prev.text) is distinct from prev.text;
  image_changed := prev.id is null and p_media_ids is not null
                   or prev.id is not null and (coalesce(p_media_ids, prev.media_ids) is distinct from prev.media_ids
                                               or coalesce(p_render_params, prev.render_params) is distinct from prev.render_params);

  insert into public.post_versions (
    content_plan_id, version_no, text_v, image_v, text, hooks, form, key_idea,
    media_ids, rendered_urls, render_params, trigger, comment_id, model, prompt_version, lint, missing_facts
  ) values (
    p_content_plan_id,
    cp.version_no + 1,
    coalesce(prev.text_v, 0) + case when text_changed then 1 else 0 end,
    coalesce(prev.image_v, 0) + case when image_changed then 1 else 0 end,
    coalesce(p_text, prev.text),
    coalesce(p_hooks, prev.hooks),
    coalesce(p_form, prev.form),
    coalesce(p_key_idea, prev.key_idea),
    coalesce(p_media_ids, prev.media_ids, '{}'),
    coalesce(p_rendered_urls, prev.rendered_urls, '{}'),
    coalesce(p_render_params, prev.render_params, '{}'::jsonb),
    p_trigger, p_comment_id, p_model, p_prompt_version, p_lint, coalesce(p_missing_facts, '[]'::jsonb)
  ) returning * into v;

  update public.content_plan
     set current_version_id = v.id,
         version_no = v.version_no,
         review_status = p_review_status,
         updated_at = now()
   where id = p_content_plan_id;

  if p_comment_id is not null then
    update public.review_comments set status = 'applied' where id = p_comment_id;
  end if;
  return v;
end $$;

-- ───────────────────────── доступ: лише service role (Vercel API, n8n) ─────────────────────────
alter table public.post_versions   enable row level security;
alter table public.review_comments enable row level security;
alter table public.data_requests   enable row level security;
alter table public.ira_rules       enable row level security;
alter table public.render_prefs    enable row level security;
revoke all on function public.tl_add_version from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.tl_add_version to service_role;
  end if;
end $$;

-- перечитати схему PostgREST, щоб нові колонки/RPC були видні одразу
notify pgrst, 'reload schema';

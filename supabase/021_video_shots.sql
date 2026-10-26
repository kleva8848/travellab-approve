-- TravelLab Approve · 021 · сторіз і рілс: автоконвеєр Drive 00_Inbox → кадри → чернетка (сет 5, 26.10)
-- Запуск: Supabase → SQL Editor → Run (після 018 + 019 + 020). Повторний запуск безпечний (if not exists).
--
-- montage-test/video_inbox.py: нові файли з Drive 00_Inbox (WF-060) → ffprobe + аркуш кадрів → Claude описує
--   (готель / острів / загальне, є люди?) → video_clips (файл) + video_shots (шматки 2–6 с з мітками й оцінкою).
-- montage-test/video_agent.py: слоти IG Вт рілс / Ср, Сб сторіз з content_plan → план (рецепт + 2–4 шоти + тексти тоном Іри)
--   → stories.py --clean → video_drafts (ready_for_review, scheduled_for = слот) або «бракує кадрів» → video_slots.
-- Дайджест WF-050 і «Сьогодні» читають video_drafts + video_slots: «🎬 готово N» / «📹 бракує кадрів для <тема>».

-- ───────────── файли з Drive ─────────────
create table if not exists public.video_clips (
  id              uuid primary key default gen_random_uuid(),
  drive_file_id   text not null unique,                 -- id не змінюється, навіть якщо файл перенесуть у Hotels/…
  name            text not null,                        -- IMG_7809.MOV
  folder          text not null default '',             -- підпапка 00_Inbox (назва = підказка Іри), '' — корінь
  md5             text,
  size_bytes      bigint,
  local_file      text,                                 -- файл у montage.inbox на Mac (reels/inbox/IMG_7809.MOV)
  dur             numeric(7, 2),
  width           int,
  height          int,
  hdr             boolean not null default false,
  gps             text,                                 -- ISO6709 з .MOV, якщо є
  shot_at         timestamptz,                          -- дата зйомки з файлу
  device          text,
  scene           text not null default '',             -- опис одним реченням
  class_level     text check (class_level in ('hotel', 'destination', 'general')),
  place           text not null default '',             -- «Мальдіви», «Англія · Касл-Кум»
  hotel_id        text references public.hotels (hotel_id) on delete set null,
  has_people      boolean not null default false,
  usability       text not null default 'ok' check (usability in ('ok', 'crop', 'reject')),
  class_signals   jsonb not null default '{}',          -- {folder, gps, cluster, vision, hotel_guess, reason}
  processed_at    timestamptz,
  process_error   text,
  created_at      timestamptz not null default now()
);

-- ───────────── шоти (монтаж бере шоти, а не файли) ─────────────
create table if not exists public.video_shots (
  id             uuid primary key default gen_random_uuid(),
  clip_id        uuid not null references public.video_clips (id) on delete cascade,
  idx            int not null,                          -- номер шоту в кліпі
  t_start        numeric(7, 2) not null,                -- с від початку оригіналу
  t_end          numeric(7, 2) not null,
  label          text not null default '',              -- «тінь пальми» — так кадр бачить Іра у вкладці «Кадри»
  tags           text[] not null default '{}',          -- sea, beach, aerial, villa, room, pool, kids, food, sunset, detail, nature, city, spa
  score          int not null default 3 check (score between 1 and 5),
  has_people     boolean not null default false,
  crop_x         numeric(3, 2) not null default 0.5,    -- smart-crop 9:16 по горизонталі (0..1)
  usable         boolean not null default true,
  thumb_path     text,                                  -- shots/<clip>/<idx>.jpg у bucket video
  usage_count    int not null default 0,
  last_used_at   timestamptz,
  unique (clip_id, idx)
);
create index if not exists video_shots_pick_idx on public.video_shots (usable, last_used_at);

-- ───────────── слоти відео: готово / бракує кадрів ─────────────
create table if not exists public.video_slots (
  plan_id        uuid primary key references public.content_plan (id) on delete cascade,
  scheduled_for  date not null,
  format         text not null check (format in ('stories', 'reel')),
  topic          text not null default '',              -- «Пара з приводом · сторіз» — те, що бачить Іра
  state          text not null check (state in ('ready', 'gap')),
  draft_id       uuid references public.video_drafts (id) on delete set null,
  need           text,                                  -- gap: чого бракує простими словами («вілла або басейн, 2+ кадри»)
  checked_at     timestamptz not null default now()
);
create index if not exists video_slots_state_idx on public.video_slots (state, scheduled_for);

-- чернетка знає свій слот і як її зібрали
alter table public.video_drafts
  add column if not exists plan_id uuid references public.content_plan (id) on delete set null,
  -- {recipe, topic, shot_ids[], model, at} — від video_agent.py; null — завантажено вручну (upload_drafts.py)
  add column if not exists auto jsonb;
create unique index if not exists video_drafts_plan_idx on public.video_drafts (plan_id) where plan_id is not null;

alter table public.video_clips enable row level security;
alter table public.video_shots enable row level security;
alter table public.video_slots enable row level security;

notify pgrst, 'reload schema';

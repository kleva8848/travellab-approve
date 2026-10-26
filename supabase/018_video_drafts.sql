-- TravelLab Approve · 018 · сторіз і рілс в апці: чернетки відео (сет 2, 23.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний (if not exists / on conflict).
-- Без цього SQL: блок «Відео на перегляд» на «Сьогодні» просто не показується (демо ?demo=1 працює й так).
--
-- Модель: «чисте» відео (кадри без тексту, змонтоване на Mac — montage-test/upload_drafts.py) + план шарів (plan jsonb).
-- Іра правує план в апці (/api/video save) і затверджує (approve). Фінальний mp4 з шарами — сет 3 (воркер).

-- ───────────── сховище (приватне: доступ лише через service role / signed URL) ─────────────
-- 50 МБ на файл — межа Free-плану; чисте 1080p сторіз ≈ 10–15 МБ, web 720p ≈ 1–2 МБ
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video', 'video', false, 52428800, array['video/mp4', 'image/jpeg'])
on conflict (id) do nothing;

-- ───────────── чернетки ─────────────
create table if not exists public.video_drafts (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,                 -- stories_2026-10-22_01 — щоб повторне завантаження оновлювало рядок, а не дублювало
  name           text not null,                        -- «Острів, де час повільніший»
  format         text not null default 'stories' check (format in ('stories', 'reel')),
  platform       text not null default 'instagram' check (platform in ('instagram', 'telegram')),
  place          text not null default '',             -- «Мальдіви»
  hotel_id       text references public.hotels (hotel_id),
  dur            numeric(6, 2) not null,               -- тривалість чистого відео, с
  clean_path     text not null,                        -- <slug>/clean.mp4 — 1080×1920, для фінального рендеру
  web_path       text not null,                        -- <slug>/web.mp4 — 720p для прев'ю в апці
  poster_path    text not null,                        -- <slug>/poster.jpg
  shots          jsonb not null default '[]',          -- [{t0, t1, label, file, thumb_path}] — межі кадрів у чистому відео
  plan           jsonb not null default '{}',          -- {texts: VText[], wm: {kind, pos, color}, cover} — шари (src/lib/video.ts)
  status         text not null default 'ready_for_review' check (status in ('ready_for_review', 'approved', 'skipped')),
  scheduled_for  timestamptz,                          -- слот публікації (сет 5, WF-051)
  approved_at    timestamptz,
  approved_by    bigint,                               -- TG ID
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists video_drafts_status_idx on public.video_drafts (status, created_at desc);

alter table public.video_drafts enable row level security;

notify pgrst, 'reload schema';

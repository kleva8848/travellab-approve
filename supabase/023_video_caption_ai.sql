-- TravelLab Approve · 023 · AI-правка підпису до відео (рілс / Telegram), сет Д3 · 27.10
-- Запуск: Supabase → SQL Editor → Run (після 022). Повторний запуск безпечний (if not exists).
--
-- Іра пише правку до підпису в апці → Vercel /api/video { action: 'caption_ai' } → n8n «[TravelLab] Video Caption Rewrite» (WF-061)
-- → новий video_drafts.caption. Відео не перемонтовується й не скидається — міняється лише текст під ним.
-- Правки лишаються тут з kind = null — сет 2: WF-057 «Learn From Edits» робить з них ira_rules, як з правок постів.

create table if not exists public.video_caption_comments (
  id              uuid primary key default gen_random_uuid(),
  video_draft_id  uuid not null references public.video_drafts (id) on delete cascade,
  body            text not null,
  chips           text[] not null default '{}',
  author_tg_id    bigint,
  caption_before  text,
  caption_after   text,
  status          text not null default 'processing' check (status in ('processing', 'applied', 'failed')),
  kind            text check (kind in ('one_off', 'style_rule', 'fact_correction')),  -- класифікатор WF-057 (сет 2)
  created_at      timestamptz not null default now()
);

create index if not exists video_caption_comments_draft_idx on public.video_caption_comments (video_draft_id, created_at);
create index if not exists video_caption_comments_learn_idx on public.video_caption_comments (created_at) where kind is null and status = 'applied';

alter table public.video_caption_comments enable row level security;

notify pgrst, 'reload schema';

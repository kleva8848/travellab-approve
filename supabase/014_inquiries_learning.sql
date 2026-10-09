-- TravelLab Approve · 014 · «з цього поста написали» (вимір звернень) + навчання на правках (фаза 7)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний (if not exists).
-- Без цього SQL апка працює як раніше: кнопки «💬 Написали» просто нема.

-- ───────────────────────── post_inquiries: Іра відмічає звернення з поста ─────────────────────────
-- Один тап = один рядок (видно, коли саме написали); «−1» видаляє останній рядок цього поста.
-- Аналітика: select cp.platform, cp.pillar, count(*) from post_inquiries i join content_plan cp on cp.id = i.content_plan_id group by 1, 2;
create table if not exists public.post_inquiries (
  id               bigserial primary key,
  content_plan_id  uuid not null references public.content_plan (id) on delete cascade,
  author_tg_id     bigint,
  created_at       timestamptz not null default now()
);

create index if not exists post_inquiries_plan_idx on public.post_inquiries (content_plan_id, created_at desc);

alter table public.post_inquiries enable row level security;

notify pgrst, 'reload schema';

-- ───────────────────────── навчання на правках (фаза 7) ─────────────────────────
-- n8n «[TravelLab] Learn From Edits» розбирає й власні правки тексту Іри в апці (post_versions prompt_version='ira_edit').
-- learned_at — позначка «вже розібрано». Без колонки WF просто пропускає цей шматок (коментарі розбирає як завжди).
alter table public.post_versions add column if not exists learned_at timestamptz;

-- Швидкий пошук нерозібраних правок (review_comments.kind is null)
create index if not exists review_comments_unlearned_idx on public.review_comments (created_at) where kind is null;

notify pgrst, 'reload schema';

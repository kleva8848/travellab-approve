-- TravelLab Approve · 022 · сторіз і рілс: публікація готового відео (сет 7, 26.10)
-- Запуск: Supabase → SQL Editor → Run (після 018–021). Повторний запуск безпечний (if not exists / on conflict).
--
-- n8n «[TravelLab] Autopublish TG» (WF-052) кожні 5 хв кличе Vercel /api/publish → server/video_publish.ts:
--   Telegram (є канал і autopublish_tg = on) — у час слоту sendVideo в канал → published_at;
--   Instagram (і TG без каналу) — у час слоту бот шле Ірі в чат файл(и) + обкладинку + підпис → delivered_at;
--     Іра викладає сама й тисне «✅ Виклала» (бот WF-055 або апка) → published_at.
-- Правка / «Повернути на перегляд» до публікації чистить final_* разом з delivered_at → нове відео прийде в чат ще раз.

alter table public.video_drafts
  add column if not exists caption       text,         -- підпис до поста (тон PRMPT-011): агент / final_worker.py; Іра правує в апці
  add column if not exists nomusic_path  text,         -- <slug>/final_nomusic.mp4 — рілс без музики (музику ставить в Instagram); голос лишається
  add column if not exists publish_slot  text,         -- слот (scheduled_for), який уже пробували: після помилки не повторюємо
  add column if not exists delivered_at  timestamptz,  -- бот надіслав Ірі в чат «виклади зараз»
  add column if not exists published_at  timestamptz,  -- вийшло: у канал (авто) або Іра натиснула «✅ Виклала»
  add column if not exists published_ref jsonb;        -- { chat_id, message_ids[], via: channel | chat, posted_via?: bot | app, posted_by? }

-- черга публікації
create index if not exists video_drafts_publish_idx on public.video_drafts (scheduled_for)
  where status = 'approved' and published_at is null;

insert into public.settings (key, value, note) values
  ('video_ig_send',      '"on"'::jsonb, 'відео для Instagram: у час слоту бот шле Ірі в чат файл + обкладинку + підпис (on | off)'),
  ('tg_test_channel_id', null,          'тестовий канал (-100…) для перевірки відправки відео (/api/publish з video_id + chat_id)')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

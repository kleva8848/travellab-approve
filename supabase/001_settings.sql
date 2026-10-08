-- TravelLab Approve · 001 · таблиця settings (Фаза 1, 2026-10-08)
-- Усі ID/URL, що відрізняються між тестовою інфрою Влада і акаунтами Іри, живуть тут, а не в коді чи нодах n8n.
-- Перенос (план §7) = нові значення в цій таблиці. Запуск: Supabase → SQL Editor → Run (повторний запуск безпечний).

do $$
begin
  -- захист: якщо в базі вже є чужа таблиця settings з іншою схемою — зупиняємось, нічого не чіпаємо
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'settings')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'settings' and column_name = 'value' and data_type = 'jsonb') then
    raise exception 'public.settings вже існує з іншою схемою — перейменуй таблицю в міграції';
  end if;
end $$;

create table if not exists public.settings (
  key        text primary key,
  value      jsonb,
  note       text,
  updated_at timestamptz not null default now()
);

-- Доступ лише через service role (Vercel API, n8n). anon/authenticated нічого не бачать
alter table public.settings enable row level security;

create or replace function public.settings_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.settings_touch();

-- Ключі з порожніми значеннями: заповнюються вручну (on conflict — існуючі значення не перетираємо)
insert into public.settings (key, value, note) values
  ('bot_username',          null, 'юзернейм бота Іри без @, напр. travellab_studio_bot'),
  ('mini_app_url',          null, 'https://<vercel-домен> — для кнопок web_app у повідомленнях бота'),
  ('ira_chat_id',           null, 'TG ID Іри (приватний чат з ботом) — куди слати дайджест і «нова версія готова»'),
  ('admin_chat_id',         null, 'TG ID Влада — дайджест правил, помилки'),
  ('n8n_webhook_base',      null, 'https://<n8n>/webhook — база для review-action / generate / render / media-ingest'),
  ('drive_root_folder_id',  null, 'ID кореневої папки «Travel lab» на Google Drive'),
  ('drive_hotel_folders',   '{}'::jsonb, 'мапа hotel_id → drive folder id (заповнює n8n при створенні папки)'),
  ('digest_time',           '"10:00"'::jsonb, 'коли бот шле Ірі ранковий дайджест (Europe/Kyiv)'),
  ('render_default_mode',   '"auto"'::jsonb, 'обробка фото: auto | none | soft | look (фаза 0, чекає вибору Іри)')
on conflict (key) do nothing;

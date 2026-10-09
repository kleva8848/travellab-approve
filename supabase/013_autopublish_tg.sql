-- TravelLab Approve · 013 · автопублікація TG у канал (§27 #12, 09.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний. Код працює й без цього файлу (лише без позначок нижче).

-- autopublish_slot — слот 'YYYY-MM-DD HH:MM', який автопублікація вже пробувала: після помилки не повторює (не спамить Владу),
--   після «Повернути» в календарі не викладе вдруге той самий слот. Перенесла дату/час → новий слот → спробує знову.
-- published_ref — куди і що вийшло: { chat_id, message_ids[], mode, auto }
alter table public.content_plan
  add column if not exists autopublish_slot text,
  add column if not exists published_ref    jsonb;

-- Перемикач і канал. За замовчуванням ВИМКНЕНО; tg_channel_id порожній, поки бот не адмін каналу Іри
insert into public.settings (key, value, note) values
  ('autopublish_tg',        '"off"'::jsonb, 'автопублікація TG-постів у канал: on | off'),
  ('tg_channel_id',         null,           'ID каналу Іри (-100…) або @username — бот має бути адміном з правом публікації'),
  ('autopublish_grace_min', '60'::jsonb,    'скільки хв після часу слоту ще викладати автоматом (давніші пропущені — лише вручну)')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- TravelLab Approve · 005 · нагадування за 30 хв + ранковий дайджест (09.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.

-- Про який слот бот уже нагадав: 'YYYY-MM-DD HH:MM'. Якщо Іра перенесла дату/час — слот інший → нагадає знову.
-- Тому апці нічого скидати не треба
alter table public.content_plan
  add column if not exists reminded_slot text;

-- Кому слати нагадування й дайджест: admin (Влад, на час тестів) | ira | both
insert into public.settings (key, value, note) values
  ('notify_target', '"admin"'::jsonb, 'кому нагадування/дайджест: admin | ira | both (на час тестів — admin)'),
  ('remind_before_min', '30'::jsonb, 'за скільки хвилин до публікації нагадувати')
on conflict (key) do nothing;

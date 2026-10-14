-- TravelLab Approve · 015 · 3 фото в TG-каруселі + увімкнути водяні знаки і голос (14.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний.

-- Карусель = 3 фото на будь-якій платформі (було: 3 лише в IG, TG-карусель отримувала 1 фото).
-- Стосується нових постів і «Інша фотка»; вже підібрані фото не чіпаємо.
create or replace function public.tl_photo_count(p_platform text, p_slot_type text, p_pillar text)
returns integer language sql immutable as $$
  select case
    when p_pillar in ('video', 'template') or p_slot_type in ('reel', 'stories') then 0
    when p_slot_type like '%carousel%' then 3
    else 1
  end
$$;

-- Водяні знаки Іри (справжні PNG) і кнопка «Відповісти голосом» в апці
insert into public.settings (key, value, note) values
  ('watermark',     '"on"'::jsonb, 'водяні знаки на фото: on | off'),
  ('voice_answers', '"on"'::jsonb, 'кнопка «Відповісти голосом» у «Бракує даних» (бот Іри, WF-056): on | off')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

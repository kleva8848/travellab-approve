-- 024 — розчистка черги Іри (2026-11-14, після її першого затвердженого поста)
-- Лишаємо: approved / published (і майбутні planned-слоти — їх генератор заповнить заново).
-- Решта → backlog: в апці не видно ні в черзі, ні в календарі, але нічого не видаляємо — можна повернути.
-- Запускати по кроках у Supabase SQL Editor (проект «Travel Lab Test»).

-- КРОК 1. Подивитись, що є (нічого не міняє)
select review_status,
       count(*)                                                    as всього,
       count(*) filter (where scheduled_for <  current_date)       as минулі,
       count(*) filter (where scheduled_for >= current_date)       as майбутні,
       count(*) filter (where scheduled_for is null)               as без_дати
from public.content_plan
group by review_status
order by всього desc;

-- КРОК 2. Перенести в архів (backlog)
with moved as (
  update public.content_plan
     set review_status = 'backlog',
         review_note   = left('Архів 14.11: розчистка черги після першого затвердженого поста. Було: ' || review_status, 300),
         updated_at    = now()
   where review_status not in ('approved', 'published', 'backlog', 'skipped')
     and not (review_status = 'planned' and scheduled_for >= current_date)
  returning id
)
-- відкриті питання до Іри по цих постах теж закриваємо, щоб бот не питав про старе
update public.data_requests
   set status = 'dismissed'
 where status = 'open'
   and content_plan_id in (select id from moved);

-- КРОК 3. Перевірка: має лишитись лише approved / published (+ можливо planned на майбутнє)
select review_status, scheduled_for, platform, slot_type, pillar
from public.content_plan
where review_status <> 'backlog'
order by scheduled_for nulls last;

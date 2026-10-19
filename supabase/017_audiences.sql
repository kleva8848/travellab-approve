-- TravelLab Approve · 017 · вкладка «Аудиторії»: портрети й питання клієнтів у таблиці (19.10)
-- Запуск: Supabase → SQL Editor → Run. Повторний запуск безпечний (if not exists / on conflict / сід лише в порожні).
-- Без цього SQL: вкладка показує «ще налаштовуємо», WF-018 бере портрети з коду (як до 19.10).
--
-- WF-018 (SwVveOJhn4qSbEwn): фокус тижня = активні аудиторії по колу (sort_order, ISO-тиждень плану),
-- питання — активні питання цієї аудиторії. code (P1…) — у note слоту «Для кого: P1 …» і в settings.story_prompts.

create table if not exists public.audiences (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,                -- P1, P2… (нові — наступний номер, дає API)
  name         text not null,                       -- «Пара з приводом»
  who          text not null default '',            -- хто ці люди, що їм важливо
  match_words  text not null default '',            -- слова для підбору готелів (теги / who_for / тип / локація), через кому
  active       boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.audience_questions (
  id           uuid primary key default gen_random_uuid(),
  audience_id  uuid not null references public.audiences (id) on delete cascade,
  question     text not null,
  with_hotel   boolean not null default true,       -- true — відповідь на прикладі готелю слоту; false — загальна тема (Threads, сторіз)
  active       boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists audience_questions_aud_idx on public.audience_questions (audience_id, sort_order);

alter table public.audiences          enable row level security;
alter table public.audience_questions enable row level security;

-- ───────────────────────── сід: PERSONAS + TOPIC_BANK з n8n/build_weekly_plan.mjs (Audience_Strategy_v3) ─────────────────────────
insert into public.audiences (code, name, who, match_words, sort_order) values
  ('P1', 'Пара з приводом', 'пара 35–45, ювілей / подарунок / романтика, без дітей; хочуть цікаво, активно і гарно',
   'couple, adults, romant, honeymoon, пар, двох, романт, ювіл', 1),
  ('P2', 'Багатодітна сім''я', 'сім''я з 2–4 дітьми; потрібна сімейна інфраструктура, вілли / connecting rooms, щоб кожен був зайнятий',
   'family, kids, сім, діт, вілл, villa, connect', 2),
  ('P3', 'Жінки в подорожі', 'дві подруги або мама з дочкою; короткі поїздки, комфорт, spa, гарні місця, безпека',
   'spa, wellness, women, girls, подруг, жін, релакс', 3),
  ('P4', 'Європу бачили — далеко ще ні', 'активні 35–45 з коштами, об''їздили Європу, але не були на Індійському океані; бояться перельоту й не знають, як організувати',
   'maldiv, мальдів, seychel, сейшел, mauri, маврик, madagas, мадагас, island, остр', 4)
on conflict (code) do nothing;

insert into public.audience_questions (audience_id, question, with_hotel, sort_order)
select a.id, q.question, q.with_hotel, q.n
from (values
  ('P1', true,  1, 'Куди поїхати вдвох на ювілей, щоб було і красиво, і не нудно?'),
  ('P1', true,  2, 'Який готель обрати для сюрпризу-подарунка, щоб вразити, а не просто «гарно»?'),
  ('P1', true,  3, 'Де на островах і активно (снорклінг, спорт), і романтично ввечері?'),
  ('P1', true,  4, 'Як обрати віллу, щоб фото були як у журналі, а не як у всіх?'),
  ('P1', false, 5, 'Чи страшно плавати з акулами й скатами — і чому це найкраща частина поїздки?'),
  ('P1', false, 6, 'За скільки планувати подорож-подарунок на дату, щоб встигнути все добре?'),
  ('P2', true,  1, 'Чим будуть зайняті діти різного віку, поки батьки відпочивають?'),
  ('P2', true,  2, 'Вілла чи connecting rooms — як розселити велику сім''ю, щоб діти спали окремо від дорослих?'),
  ('P2', true,  3, 'Який пляж і вхід у воду безпечні для малих дітей?'),
  ('P2', true,  4, 'Що в сімейному готелі має бути обов''язково, коли дітей троє-четверо?'),
  ('P2', false, 5, 'Як довго летіти з дітьми з України і як зробити дорогу легшою?'),
  ('P2', false, 6, 'Близько (Греція, Іспанія) чи далеко — коли з дітьми варто летіти на океан?'),
  ('P3', true,  1, 'Куди поїхати з подругою на 5 днів, щоб відпочити по-справжньому?'),
  ('P3', true,  2, 'Куди поїхати мамі з дочкою, щоб обом було цікаво?'),
  ('P3', true,  3, 'Де гарне spa і спокійна атмосфера без «тусовки»?'),
  ('P3', false, 4, 'Як Іра супроводжує в поїздці: що робити, якщо щось пішло не так?'),
  ('P3', false, 5, 'Як можна оплатити поїздку і що входить у ціну?'),
  ('P4', true,  1, 'Чим острівний готель відрізняється від «шаблонного» резорту, де ви вже були тисячу разів?'),
  ('P4', true,  2, 'Новий нішевий готель чи перевірений відомий — що обрати вперше?'),
  ('P4', true,  3, 'Що побачити на Індійському океані, чого не буде в хорошому готелі в Єгипті?'),
  ('P4', false, 4, 'Чи довго добиратися на Мальдіви з України і як це виглядає насправді?'),
  ('P4', false, 5, 'Сезони на Мальдівах: коли шторми, хвилі й мусони, і чому ціни різні?'),
  ('P4', false, 6, 'Чому ціни на відпочинок стали втричі вищі і з чого складається вартість?'),
  ('P4', false, 7, 'Як організувати першу далеку подорож, якщо ніколи не летіли так далеко?')
) as q (code, with_hotel, n, question)
join public.audiences a on a.code = q.code
where not exists (select 1 from public.audience_questions x where x.audience_id = a.id);

notify pgrst, 'reload schema';

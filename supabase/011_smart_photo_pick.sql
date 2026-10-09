-- TravelLab Approve · 011 · розумний підбір фото під пост (6d, 09.10)
-- Потрібна 004. Запуск: Supabase → SQL Editor → Run (повторний запуск безпечний).
-- Без цього файлу все працює як раніше (004: найменш використані + random).
--
-- Детермінований скоринг, без LLM і без нових колонок (has_people / shot_type у media поки немає —
-- заповнені лише description (UA), tags (EN), width/height, usage_count, last_used_at):
--   + збіг слів тексту поста з описом фото (основи слів, вага рідкісних слів вища — idf серед фото готелю)
--   + збіг з тегами фото через словник UA→EN (пляж→beach, захід→sunset, басейн→pool …)
--   + підказка рубрики (pillar), слабко
--   + перше фото — «загальний план» (view/beach/sunset/pool/…), IG — вертикальне фото трохи краще
--   − стоїть в іншому активному пості (практично виключено, як у 004)
--   − вже було в цьому пості раніше («Інша фотка» не ходить по колу між двома)
--   − використане у затверджених постах (usage_count), нещодавно (last_used_at, 60 днів)
--   − схоже на вже вибрані фото каруселі: той самий «план» (tl_scene: пляж/номер/їжа/трансфер/…) + схожий опис
-- tl_pick_media (3 аргументи) лишається тим самим входом для апки й tl_attach_photos — тепер ранжує.
-- Buffer Filler кличе tl_pick_media_ranked з текстом, бо версії поста ще немає.

-- ───────────── основи слів (грубий стемер для української) ─────────────
create or replace function public.tl_stems(p_text text)
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct s), '{}') from (
    select regexp_replace(w, '(ами|ями|ого|ому|ими|іми|ий|ій|ою|ею|ам|ям|ах|ях|ом|ем|ів|ої|ей|а|я|о|е|і|и|у|ю|ь|ї|й)$', '') as s
    from regexp_split_to_table(lower(coalesce(p_text, '')), '[^а-яґєіїa-z0-9]+') as w
    where char_length(w) >= 4
  ) t
  where char_length(s) >= 3
    and s not in ('якщо', 'тобт', 'дуж', 'також', 'тільк', 'цьог', 'цей', 'ваш', 'наш', 'можн', 'буд', 'біль', 'кол', 'який', 'як',
                  'with', 'from', 'that', 'this', 'your')
$$;

-- ───────────── словник: основа слова тексту → теги фото (EN, як їх пише Vision) ─────────────
create or replace function public.tl_stem_tags(p_stems text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct t), '{}') from (
    select unnest(d.tags) as t
    from unnest(p_stems) s
    join (values
      ('пляж',      array['beach','sand','seaside']),
      ('піщ',       array['beach','sand']),
      ('піс',       array['beach','sand']),
      ('захід',     array['sunset','evening']),
      ('заход',     array['sunset','evening']),
      ('світан',    array['sunset','sky']),
      ('басейн',    array['pool']),
      ('номер',     array['room','interior']),
      ('вілл',      array['room','interior','private','bungalow']),
      ('люкс',      array['room','interior']),
      ('спальн',    array['room','interior']),
      ('інтер',     array['interior','design']),
      ('вечер',     array['dinner','dining','evening']),
      ('ресторан',  array['restaurant','dining','dinner','gourmet']),
      ('гастро',    array['gourmet','dining']),
      ('кухн',      array['gourmet','dining']),
      ('страв',     array['gourmet','dining','seafood']),
      ('снідан',    array['dining']),
      ('морепрод',  array['seafood']),
      ('десерт',    array['dessert','treat']),
      ('морозив',   array['icecream','dessert','treat']),
      ('спа',       array['wellness','spa']),
      ('масаж',     array['wellness','spa']),
      ('йог',       array['meditation','wellness']),
      ('медит',     array['meditation','wellness']),
      ('гідроплан', array['seaplane','aerial']),
      ('літак',     array['plane','seaplane']),
      ('перельот',  array['plane','seaplane','airport']),
      ('трансфер',  array['seaplane','plane','helicopter']),
      ('гелікопт',  array['helicopter','aerial']),
      ('вертол',    array['helicopter','aerial']),
      ('аеропорт',  array['airport','plane']),
      ('снорк',     array['snorkeling','water']),
      ('маск',      array['snorkeling']),
      ('дайв',      array['snorkeling','water']),
      ('риф',       array['snorkeling','water','lagoon']),
      ('лагун',     array['lagoon','water']),
      ('океан',     array['ocean','water','sea']),
      ('мор',       array['sea','ocean','water']),
      ('морськ',    array['sea','ocean','water']),
      ('вод',       array['water']),
      ('остр',      array['island','tropical']),
      ('пальм',     array['palm','tropical']),
      ('тропі',     array['tropical','palm']),
      ('джунгл',    array['nature','tropical']),
      ('природ',    array['nature','landscape']),
      ('гор',       array['mountains','mountain']),
      ('гір',       array['mountains','mountain']),
      ('гірськ',    array['mountains','mountain']),
      ('озер',      array['lake','water']),
      ('річк',      array['river','water']),
      ('терас',     array['terrace','view']),
      ('бунгал',    array['bungalow']),
      ('краєвид',   array['view','scenery','landscape']),
      ('панорам',   array['view','scenery']),
      ('вид',       array['view','scenery']),
      ('сімейн',    array['family']),
      ('сім',       array['family']),
      ('діт',       array['family']),
      ('дитяч',     array['family']),
      ('роман',     array['romantic']),
      ('медов',     array['romantic']),
      ('пар',       array['romantic']),
      ('ніч',       array['night','evening']),
      ('вечір',     array['evening','night']),
      ('прогулян',  array['walk']),
      ('велосипед', array['bike']),
      ('пригод',    array['adventure']),
      ('тиш',       array['peace','calm','serenity','tranquil','peaceful']),
      ('спок',      array['peace','calm','serenity','tranquil','peaceful']),
      ('релакс',    array['relaxation','relax'])
    ) as d(key, tags)
      -- короткі ключі (≤3) — лише точний збіг, довші — як префікс основи
      on (char_length(d.key) <= 3 and s = d.key) or (char_length(d.key) > 3 and s like d.key || '%')
  ) x
$$;

-- ───────────── «план» фото за тегами (замість shot_type, якого в media ще нема) ─────────────
-- Фото може мати кілька «планів» (пляж + захід). Для різноманіття каруселі й обкладинки.
create or replace function public.tl_scene(p_tags text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(g.scene), '{}') from (values
    ('transfer', array['seaplane','plane','helicopter','airport']),
    ('food',     array['dining','dinner','gourmet','restaurant','seafood','dessert','icecream','treat']),
    ('room',     array['room','interior','bungalow','design']),
    ('pool',     array['pool']),
    ('wellness', array['spa','wellness','meditation','yoga']),
    ('sunset',   array['sunset','night','evening']),
    ('beach',    array['beach','sand','seaside','waves','shells','crab']),
    ('water',    array['snorkeling','lagoon','ocean','sea','water']),
    ('view',     array['view','landscape','scenery','aerial','mountains','mountain','nature','island'])
  ) as g(scene, tags)
  where coalesce(p_tags, '{}') && g.tags
$$;

-- ───────────── підбір з ранжуванням ─────────────
-- p_text     — текст поста (null → текст поточної версії)
-- p_exclude  — що не брати зовсім (поточні фото при заміні)
-- p_keep     — фото, що лишаються в пості (для різноманіття каруселі при заміні одного слайда)
-- p_first_is_cover — перший вибраний іде на обкладинку (слайд 1)
create or replace function public.tl_pick_media_ranked(
  p_plan_id        uuid,
  p_count          integer,
  p_exclude        text[]  default '{}',
  p_text           text    default null,
  p_keep           text[]  default '{}',
  p_first_is_cover boolean default true
)
returns text[]
language plpgsql
volatile                        -- тимчасова таблиця кандидатів
set search_path = public
as $$
declare
  cp      content_plan;
  txt     text := p_text;
  pstems  text[];
  ptags   text[];
  hints   text[];
  picked  text[] := '{}';
  best    record;
  i       integer;
begin
  if coalesce(p_count, 0) <= 0 then return '{}'; end if;
  select * into cp from content_plan where id = p_plan_id;
  if not found or cp.hotel_id is null then return '{}'; end if;
  if txt is null then
    select v.text into txt from post_versions v where v.id = cp.current_version_id;
  end if;

  pstems := tl_stems(txt);
  ptags  := tl_stem_tags(pstems);
  hints  := case cp.pillar
    when 'hotel_place' then array['view','room','pool','beach','interior','terrace']
    when 'atmosphere'  then array['sunset','view','relaxation','peace','evening','nature']
    when 'personal'    then array['dining','walk','bike','snorkeling','adventure','dinner']
    when 'insider'     then array['dining','gourmet','room','interior','wellness','snorkeling']
    else array['view','beach','sunset','pool','luxury']
  end;

  create temp table if not exists _tl_cand (
    media_id text primary key, tokens text[], scene text[], base numeric
  ) on commit drop;
  create temp table if not exists _tl_ctx (tokens text[], scene text[]) on commit drop;
  truncate _tl_cand;
  truncate _tl_ctx;

  with plan_hist as (           -- фото, що вже були в цьому пості (крім поточних)
    select distinct unnest(v.media_ids) as media_id
    from post_versions v where v.content_plan_id = p_plan_id
  ),
  busy as (
    select distinct unnest(v.media_ids) as media_id
    from content_plan c
    join post_versions v on v.id = c.current_version_id
    where c.id <> p_plan_id
      and c.review_status in ('ready_for_review', 'changes_requested', 'regenerating', 'needs_data', 'approved')
  ),
  cand as (
    select m.media_id,
           coalesce(m.tags, '{}')::text[] as tags,
           tl_stems(m.description) || array(select '#' || lower(t) from unnest(coalesce(m.tags, '{}')::text[]) t) as tokens,
           m.width, m.height, m.usage_count, m.last_used_at
    from media m
    where m.hotel_id = cp.hotel_id
      and m.storage_path is not null
      and coalesce(m.type, 'photo') = 'photo'
      and not (m.media_id = any(coalesce(p_exclude, '{}')))
      and not (m.media_id = any(coalesce(p_keep, '{}')))
  ),
  n as (select greatest(count(*), 1)::numeric as n from cand),
  df as (select tok, count(*)::numeric as df from cand, unnest(cand.tokens) tok group by tok),
  q as (                        -- токени поста з вагою
    select s as tok, 1.0 as w from unnest(pstems) s
    union all select '#' || t, 1.0 from unnest(ptags) t
  ),
  rel as (
    select c.media_id, coalesce(sum(q.w * ln(1 + n.n / df.df)), 0) as r
    from cand c cross join n
    left join lateral unnest(c.tokens) u(t) on true
    left join q on q.tok = u.t
    left join df on df.tok = u.t
    group by c.media_id
  ),
  mx as (select greatest(max(r), 0.0001) as mx from rel)
  insert into _tl_cand (media_id, tokens, scene, base)
  select c.media_id, c.tokens, tl_scene(c.tags),
         3.0 * rel.r / mx.mx                                                                   -- відповідність тексту 0…3
       + 0.15 * least(cardinality(array(select unnest(c.tags) intersect select unnest(hints))), 3) -- рубрика 0…0.45
       + case when cp.platform = 'instagram' and c.height > c.width * 1.05 then 0.3 else 0 end      -- IG: вертикаль
       - case when c.media_id in (select media_id from busy) then 10 else 0 end                  -- в іншому активному пості
       - case when c.media_id in (select media_id from plan_hist) then 5 else 0 end              -- уже було в цьому пості: «Інша фотка» — спершу нові
       - least(0.5 * coalesce(c.usage_count, 0), 1.5)                                            -- уже викладали
       - case when c.last_used_at is null then 0
              else 1.5 * greatest(0, 1 - extract(epoch from now() - c.last_used_at) / (60 * 86400)) end
       + random() * 0.2                                                                          -- рівні — навмання
  from cand c join rel using (media_id) cross join mx;

  -- що вже в пості (решта слайдів при заміні) — для різноманіття
  insert into _tl_ctx (tokens, scene)
  select tl_stems(m.description) || array(select '#' || lower(t) from unnest(coalesce(m.tags, '{}')::text[]) t),
         tl_scene(coalesce(m.tags, '{}')::text[])
  from media m where m.media_id = any(coalesce(p_keep, '{}'));

  for i in 1 .. p_count loop
    select c.media_id, c.tokens, c.scene,
           c.base
           + case when i = 1 and p_first_is_cover and c.scene && array['view', 'beach', 'sunset', 'pool', 'water']   -- обкладинка = загальний план
                  then case when cp.pillar like 'tour_offer%' then 1.5 else 1.0 end else 0 end
           - coalesce((select max(                                                               -- схоже на вже вибране
                 case when array(select unnest(c.scene) intersect select unnest(o.scene)) && array['beach','room','pool','food','transfer','wellness']
                      then 2.0 else 0 end                                                        -- те саме місце (пляж/номер/басейн/їжа/трансфер/спа)
                 + 0.5 * cardinality(array(select unnest(c.scene) intersect select unnest(o.scene)
                                           intersect select unnest(array['sunset','water','view'])))  -- той самий настрій
                 + case when cardinality(c.tokens) = 0 or cardinality(o.tokens) = 0 then 0
                        else cardinality(array(select unnest(c.tokens) intersect select unnest(o.tokens)))::numeric
                             / cardinality(array(select unnest(c.tokens) union select unnest(o.tokens))) end)
               from _tl_ctx o), 0) as score
      into best
    from _tl_cand c
    where not (c.media_id = any(picked))
    order by score desc, c.media_id
    limit 1;
    exit when not found;
    picked := picked || best.media_id;
    insert into _tl_ctx (tokens, scene) values (best.tokens, best.scene);
  end loop;

  return picked;
end $$;

-- ───────────── той самий вхід, що в 004 (апка, tl_attach_photos) — тепер з ранжуванням ─────────────
create or replace function public.tl_pick_media(p_plan_id uuid, p_count integer, p_exclude text[] default '{}')
returns text[]
language sql
volatile
set search_path = public
as $$
  select public.tl_pick_media_ranked(p_plan_id, p_count, p_exclude)
$$;

-- ───────────── заміна одного фото: враховує решту слайдів і чи це обкладинка ─────────────
create or replace function public.tl_attach_photos(p_plan_id uuid, p_expected_version_no integer, p_slide integer default null)
returns public.post_versions
language plpgsql
set search_path = public
as $$
declare
  cp    content_plan;
  cur   post_versions;
  need  integer;
  ids   text[];
  fresh text[];
  keep  text[];
begin
  select * into cp from content_plan where id = p_plan_id;
  if not found then raise exception 'content_plan % not found', p_plan_id; end if;
  select * into cur from post_versions where id = cp.current_version_id;
  need := tl_photo_count(cp.platform, cp.slot_type, cp.pillar);
  if need = 0 or cp.hotel_id is null then return null; end if;
  ids := coalesce(cur.media_ids, '{}');

  if p_slide is null then
    fresh := tl_pick_media_ranked(p_plan_id, need, '{}', cur.text);
    if cardinality(fresh) = 0 or fresh = ids then return null; end if;
    ids := fresh;
  else
    keep := array(select x from unnest(ids) with ordinality u(x, k) where k <> p_slide + 1);
    fresh := tl_pick_media_ranked(p_plan_id, 1, ids, cur.text, keep, p_slide = 0);
    if cardinality(fresh) = 0 then return null; end if;
    if p_slide + 1 > cardinality(ids) then ids := ids || fresh[1];
    else ids[p_slide + 1] := fresh[1];
    end if;
  end if;

  return tl_add_version(
    p_content_plan_id     => p_plan_id,
    p_text                => null,
    p_trigger             => 'photo_edit',
    p_expected_version_no => p_expected_version_no,
    p_media_ids           => ids,
    p_prompt_version      => case when p_slide is null then 'auto-photos' else 'swap-photo' end,
    p_review_status       => cp.review_status
  );
end $$;

revoke all on function public.tl_pick_media_ranked from public, anon, authenticated;
revoke all on function public.tl_pick_media from public, anon, authenticated;
revoke all on function public.tl_attach_photos from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.tl_pick_media_ranked to service_role;
    grant execute on function public.tl_pick_media to service_role;
    grant execute on function public.tl_attach_photos to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';

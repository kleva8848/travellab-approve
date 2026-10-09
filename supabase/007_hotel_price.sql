-- 007: ціна «від … за ніч» для готелю (карусель-шаблони, пости-пропозиції). Звідки: Іра (/voice чи апка) або агент з сайту готелю → Іра перевіряє
alter table public.hotels add column if not exists price_from_night numeric(10,2);
alter table public.hotels add column if not exists price_currency text not null default 'USD';
alter table public.hotels add column if not exists price_source text check (price_source in ('ira', 'site', 'agent'));
alter table public.hotels add column if not exists price_updated_at timestamptz;

-- нагадування й дайджест (WF-050) — тепер Ірі, не Владу
update public.settings set value = '"ira"' where key = 'notify_target';

notify pgrst, 'reload schema';

# TravelLab Approve

Telegram Mini App на боті Іри: поштучний перегляд і апрув постів TravelLab (текст + оброблене фото, правки, «бракує даних», календар з ручною публікацією).

- Фронт: Vite + React + Tailwind (`src/`), демо без сервера: `/?demo=1`
- API: Vercel Functions (`api/`), перевірка Telegram `initData` + білий список `ALLOWED_TG_IDS`, адміни `ADMIN_TG_IDS`
- БД: Supabase TravelLab; міграції `supabase/NNN_*.sql` запускаються вручну в SQL Editor по порядку
- Env: див. `.env.example`. **Жодних ID/токенів/URL у коді** — лише env і таблиця `settings` (перенос на акаунти Іри)
- Бот: `node scripts/setup-bot.mjs` (меню-кнопка, команди, опис) — див. скрипт
- Діагностика: `/api/health`

План (фази 0–11): `obsidian-vault/02_Project_TravelLab/Agents/01_Content_Agent/MiniApp_Approve_Plan.md`
Каркас скопійовано з `projects/p2p-cockpit` (auth/http/tg/api).

# TravelLab Approve

Telegram Mini App на боті Іри: поштучний перегляд і апрув постів TravelLab (текст + оброблене фото, правки, «бракує даних», календар з ручною публікацією).

- Фронт: Vite + React + Tailwind (`src/`), демо без сервера: `/?demo=1`
- API: Vercel Functions (`api/`), перевірка Telegram `initData` + білий список `ALLOWED_TG_IDS`, адміни `ADMIN_TG_IDS`
- БД: Supabase TravelLab; міграції `supabase/NNN_*.sql` запускаються вручну в SQL Editor по порядку
- Env: див. `.env.example`. **Жодних ID/токенів/URL у коді** — лише env і таблиця `settings` (перенос на акаунти Іри)
- Бот: `node scripts/setup-bot.mjs` (меню-кнопка, команди, опис) — див. скрипт
- Діагностика: `/api/health`
- Огляд постів (фаза 3): `/api/queue`, `/api/post?id=`, `/api/review` (approve / comment / restore / unapprove з `expected_version_no`)
- n8n «Review Action»: `n8n/build_review_action.mjs` → `n8n/review_action.json` (правка Іри → Post Generator → нова версія → бот Іри). Вебхук `travellab-review-action`, заголовок `X-TL-Secret` = `N8N_WEBHOOK_SECRET`
- Навчання на правках (фаза 7): `n8n/build_learn_edits.mjs` → «Learn From Edits» (щогодини: правки Іри → gpt-4.1 → `ira_rules` + факти в досьє), `n8n/build_rules_digest.mjs` → «Rules Digest (admin)» (пн 09:00 Владу). Правила потрапляють у генерацію через `n8n/ira_rules.mjs` (WF-046, Buffer Filler, Data Answer). Глобальні схвалює адмін в апці (`api/rules.ts`, блок «Правила з правок»)
- Backfill з Notion: `node scripts/backfill/build_backfill.mjs` → `supabase/003_backfill_notion.sql`

План (фази 0–11): `obsidian-vault/02_Project_TravelLab/Agents/01_Content_Agent/MiniApp_Approve_Plan.md`
Каркас скопійовано з `projects/p2p-cockpit` (auth/http/tg/api).

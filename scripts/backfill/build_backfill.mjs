// node scripts/backfill/build_backfill.mjs → supabase/003_backfill_notion.sql
// Переносить Notion «Content Plan (Крок 7)» (знімок 08.10) у post_versions / review_comments.
// 5 пілотних постів (раунд 3, чекають Іру) → ready_for_review; решта → backlog (старі чернетки, не в черзі).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rows = JSON.parse(readFileSync(join(here, 'notion_content_plan_2026-10-08.json'), 'utf8'))
const feedback = JSON.parse(readFileSync(join(here, 'pilot_feedback_round2.json'), 'utf8'))
const PILOT = new Set(Object.keys(feedback))

const pageId = (url) => url.split('/').pop().replace(/-/g, '').slice(-32)
const asUuid = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
const yes = (v) => v === '__YES__'

// Текст у dollar-quote з тегом, якого гарантовано немає в тексті
const q = (s) => {
  if (s == null || s === '') return 'null'
  let tag = 'tl'
  while (s.includes(`$${tag}$`)) tag += 'x'
  return `$${tag}$${s}$${tag}$`
}
const arr = (s) => {
  const parts = (s ?? '').split('|').map((x) => x.trim()).filter(Boolean)
  return parts.length ? `array[${parts.map(q).join(', ')}]::text[]` : 'null'
}
const refOf = (ref, k) => {
  for (const p of (ref ?? '').split(',')) {
    const t = p.trim()
    if (t.startsWith(k + ':')) return t.slice(k.length + 1).trim()
  }
  return null
}

const out = [
  '-- TravelLab Approve · 003 · backfill з Notion Content Plan (знімок 2026-10-08)',
  '-- ЗГЕНЕРОВАНО scripts/backfill/build_backfill.mjs — не правити руками.',
  '-- Потрібна 002. Повторний запуск безпечний: рядки, що вже мають версії, пропускаються.',
  '-- Pilot (5) → ready_for_review з коментарем Іри (раунд 2) як review_comments; решта → backlog.',
  '',
  'do $$',
  'declare',
  '  cp_id uuid; v1 uuid; v2 uuid; c_id uuid;',
  'begin',
]

let n = 0
for (const r of rows) {
  if (!r.Text) continue
  const pid = pageId(r.url)
  const pilot = PILOT.has(pid)
  const notionUuid = asUuid(pid)
  const day = r.Day, platform = r.Platform, slot = r['Slot Type'], pillar = r.Pillar
  const tour = refOf(r.Ref, 'tour'), hotel = refOf(r.Ref, 'hotel')
  const status = pilot ? 'ready_for_review' : 'backlog'
  const missing = yes(r['Needs Data']) ? `'[{"field":"unknown","note":"Needs Data (Notion)"}]'::jsonb` : `'[]'::jsonb`
  n++

  out.push(``, `  -- ${n}. ${r.Day} · ${platform} · ${pillar}${pilot ? '  [PILOT]' : ''}  notion ${pid}`)
  if (r['Content Plan ID']) {
    out.push(`  cp_id := ${q(r['Content Plan ID'])}::uuid;`)
    out.push(`  if not exists (select 1 from public.content_plan where id = cp_id) then`)
    out.push(`    raise notice 'skip: content_plan % відсутній у Supabase', cp_id; cp_id := null;`)
    out.push(`  end if;`)
  } else {
    // Рядок створено вручну в Notion → свій content_plan (шукаємо за notion_page_id, щоб не дублювати)
    out.push(`  select id into cp_id from public.content_plan where notion_page_id in (${q(pid)}, ${q(notionUuid)}) limit 1;`)
    out.push(`  if cp_id is null then`)
    out.push(`    begin`)
    out.push(`      insert into public.content_plan (day, platform, slot_type, pillar, tour_id, hotel_id, notion_page_id, generated_text, status)`)
    out.push(`      values (${q(day)}, ${q(platform)}, ${q(slot)}, ${q(pillar)}, ${q(tour)}, ${q(hotel)}, ${q(notionUuid)}, ${q(r.Text)}, 'notion_synced') returning id into cp_id;`)
    out.push(`    exception when check_violation then`)
    out.push(`      insert into public.content_plan (day, platform, slot_type, pillar, tour_id, hotel_id, notion_page_id, generated_text, status)`)
    out.push(`      values (${q(day)}, ${q(platform)}, ${q(slot)}, ${q(pillar)}, ${q(tour)}, ${q(hotel)}, ${q(notionUuid)}, ${q(r.Text)}, 'failed') returning id into cp_id;`)
    out.push(`    end;`)
    out.push(`  end if;`)
  }
  out.push(`  if cp_id is not null and not exists (select 1 from public.post_versions where content_plan_id = cp_id) then`)
  out.push(`    v1 := null; v2 := null; c_id := null;`)
  if (r['Prev Text']) {
    out.push(`    insert into public.post_versions (content_plan_id, version_no, text_v, text, trigger, prompt_version)`)
    out.push(`    values (cp_id, 1, 1, ${q(r['Prev Text'])}, 'backfill', 'notion-prev') returning id into v1;`)
    if (pilot) {
      out.push(`    insert into public.review_comments (content_plan_id, version_id, target, body, source, status)`)
      out.push(`    values (cp_id, v1, 'text', ${q(feedback[pid])}, 'notion', 'applied') returning id into c_id;`)
    }
  }
  const vno = r['Prev Text'] ? 2 : 1
  out.push(`    insert into public.post_versions (content_plan_id, version_no, text_v, text, hooks, form, key_idea, lint, missing_facts, trigger, comment_id, model, prompt_version)`)
  out.push(`    values (cp_id, ${vno}, ${vno}, ${q(r.Text)}, ${arr(r.Hooks)}, ${q(r.Form)}, ${q(r['Key Idea'])}, ${r.Lint ? `jsonb_build_object('note', ${q(r.Lint)})` : 'null'}, ${missing}, ${pilot && r['Prev Text'] ? "'comment'" : "'backfill'"}, c_id, 'gpt-4.1', ${q(pilot ? 'PRMPT-011 v4' : 'notion')}) returning id into v2;`)
  out.push(`    update public.content_plan set current_version_id = v2, version_no = ${vno}, review_status = '${status}', notion_page_id = coalesce(notion_page_id, ${q(notionUuid)}) where id = cp_id;`)
  out.push(`  end if;`)
}

out.push('end $$;', '', `-- Перевірка: очікувано ready_for_review = ${[...PILOT].length}, backlog = ${n - PILOT.size}`,
  "select review_status, count(*) from public.content_plan where current_version_id is not null group by 1 order by 1;", '')

const target = join(here, '..', '..', 'supabase', '003_backfill_notion.sql')
writeFileSync(target, out.join('\n'))
console.log(`rows ${n}, pilot ${[...PILOT].filter((p) => rows.some((r) => pageId(r.url) === p)).length} → ${target}`)

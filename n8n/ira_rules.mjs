// Правила Іри з її правок (ira_rules, фаза 7) → у вхід Post Generator. Спільний шматок для WF-046 / Buffer Filler / Data Answer.
// Генератор (VZk3w2jPwXFexId2, PRMPT-011 v4) поле rules[] НЕ читає, а сам генератор/промпт не чіпаємо (рішення Влада).
// Тому кладемо правила туди, що генератор уже читає:
//   • mode 'regenerate' з фідбеком → дописуємо в ira_feedback (блок «ФІДБЕК ІРИ…» у user prompt);
//   • інакше (перша генерація) → першим елементом fewshot (блок «ПРИКЛАДИ…» у system prompt) з позначкою «це не приклад».
// rules[] теж лишаємо — коли генератор навчиться їх читати, досить буде прибрати applyIraRules.
// Діють лише status=active: hotel/platform/pillar — одразу після класифікатора, global — після ✅ Влада.
export const RULES_JS = `
const IRA_RULES_MAX = 12;
const IRA_SCOPE_ORDER = { hotel: 0, pillar: 1, platform: 2, global: 3 };
function pickIraRules(rows, plan) {
  const seen = new Set();
  return (rows || [])
    .filter(r => r && r.rule_text && r.status === 'active' && (r.scope === 'global'
      || (r.scope === 'platform' && r.scope_value === plan.platform)
      || (r.scope === 'pillar' && r.scope_value === plan.pillar)
      || (r.scope === 'hotel' && plan.hotel_id && r.scope_value === plan.hotel_id)))
    .sort((a, b) => (IRA_SCOPE_ORDER[a.scope] - IRA_SCOPE_ORDER[b.scope]) || String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => String(r.rule_text).trim())
    .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, IRA_RULES_MAX);
}
function iraRulesBlock(rules) {
  return 'ПРАВИЛА ІРИ З ЇЇ ПОПЕРЕДНІХ ПРАВОК (дотримуйся в цьому пості; жорсткі заборони вище мають пріоритет):\\n' + rules.map(r => '— ' + r).join('\\n');
}
function applyIraRules(input, rules) {
  const out = { ...input, rules };
  if (!rules.length) return out;
  const block = iraRulesBlock(rules);
  if (out.mode === 'regenerate' && out.had_feedback && out.ira_feedback) out.ira_feedback = out.ira_feedback + '\\n\\n' + block;
  else out.fewshot = [{ text: '(Це не приклад поста, а її правила.)\\n' + block }, ...(Array.isArray(out.fewshot) ? out.fewshot : [])];
  return out;
}
`

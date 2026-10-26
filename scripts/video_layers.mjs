#!/usr/bin/env node
// Шари фінального відео для воркера (montage-test/final_worker.py):
//   node --no-warnings scripts/video_layers.mjs <job.json> <out_dir>
// job.json: { plan: {texts, wm, cover}, shots: [{t0, t1}], dur }
// → <out_dir>/text_N.png, wm.png (якщо знак є), layers.json { texts: [{file, t0, t1, fadeIn, fadeOut}], wm }
// Node ≥ 23.6 сам знімає типи з .ts (server/video_layers.ts — той самий layout, що прев'ю в апці)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { videoLayers } from '../server/video_layers.ts'

const [jobPath, outDir] = process.argv.slice(2)
if (!jobPath || !outDir) {
  console.error('usage: node scripts/video_layers.mjs <job.json> <out_dir>')
  process.exit(2)
}
const job = JSON.parse(readFileSync(jobPath, 'utf8'))
mkdirSync(outDir, { recursive: true })
const r = await videoLayers(job.plan, job.shots, Number(job.dur))
const texts = r.texts.map((l, i) => {
  const file = `text_${i}.png`
  writeFileSync(join(outDir, file), l.png)
  return { file, t0: l.t0, t1: l.t1, fadeIn: l.fadeIn, fadeOut: l.fadeOut }
})
if (r.wm) writeFileSync(join(outDir, 'wm.png'), r.wm)
writeFileSync(join(outDir, 'layers.json'), JSON.stringify({ texts, wm: r.wm ? 'wm.png' : null }, null, 1))
console.log(`шари: ${texts.length} текст(ів)${r.wm ? ' + знак' : ''} → ${outDir}`)

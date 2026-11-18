#!/usr/bin/env node
// Обкладинка для воркера (montage-test/cover.py):
//   node --no-warnings scripts/video_cover.mjs <job.json> <out.jpg>
// job.json: { bg: <шлях до чистого кадру 1080×1920>, spec: {kicker, title, wm: {kind,pos,color}} }
// Той самий satori-рушій, що шари відео (server/video_layers.ts)
import { readFileSync, writeFileSync } from 'node:fs'
import { coverJpeg } from '../server/video_layers.ts'

const [jobPath, out] = process.argv.slice(2)
if (!jobPath || !out) {
  console.error('usage: node scripts/video_cover.mjs <job.json> <out.jpg>')
  process.exit(2)
}
const job = JSON.parse(readFileSync(jobPath, 'utf8'))
writeFileSync(out, await coverJpeg(readFileSync(job.bg), job.spec))
console.log(`обкладинка → ${out}`)

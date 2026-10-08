// Одноразове налаштування бота Іри після отримання токена (Фаза 1).
// Запуск: TELEGRAM_BOT_TOKEN=... MINI_APP_URL=https://... node scripts/setup-bot.mjs
// Повторний запуск безпечний (Telegram просто перезапише ті самі значення).
const token = process.env.TELEGRAM_BOT_TOKEN
const appUrl = process.env.MINI_APP_URL
if (!token || !appUrl) {
  console.error('Потрібні TELEGRAM_BOT_TOKEN і MINI_APP_URL')
  process.exit(1)
}
if (!appUrl.startsWith('https://')) {
  console.error('MINI_APP_URL має бути https://')
  process.exit(1)
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const j = await r.json()
  console.log(j.ok ? '✅' : '❌', method, j.ok ? '' : j.description)
  if (!j.ok) process.exitCode = 1
  return j.result
}

const me = await tg('getMe')
if (!me) process.exit(1)
console.log(`   бот: @${me.username} (${me.first_name})`)

// Кнопка зліва від поля вводу в чаті з ботом → відкриває апку
await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'TravelLab', web_app: { url: appUrl } } })
await tg('setMyCommands', { commands: [{ command: 'start', description: 'Відкрити TravelLab' }] })
await tg('setMyShortDescription', { short_description: 'Пости TravelLab: перегляд, правки, календар' })
await tg('setMyDescription', {
  description: 'Робочий бот TravelLab. Тут з’являються пости на перегляд, питання про готелі й нагадування про публікацію. Натисни «TravelLab» внизу, щоб відкрити застосунок.',
})

console.log(`\nДалі вручну: аватар — @BotFather → /setuserpic → @${me.username} → лого Іри.`)
console.log(`У settings: bot_username = "${me.username}", mini_app_url = "${appUrl}"`)

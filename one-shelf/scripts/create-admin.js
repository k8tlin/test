'use strict'
// Create an admin user (there is no default one).
//
//   node scripts/create-admin.js you@example.com            prompts for a password
//   ADMIN_PASSWORD='...' node scripts/create-admin.js you@example.com     scripted use
//   node scripts/create-admin.js you@example.com --reset    set a new password for an existing admin

const readline = require('node:readline')
const { loadConfig, ConfigError } = require('../src/config')
const { openDb } = require('../src/db')
const { hashPassword, passwordProblem, MIN_LENGTH } = require('../src/security/passwords')
const { email: emailSchema } = require('../src/security/validate')

function promptHidden (question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Piped input: read one line as the password.
      const rl = readline.createInterface({ input: process.stdin })
      let answered = false
      rl.once('line', (line) => { answered = true; rl.close(); resolve(line) })
      rl.once('close', () => { if (!answered) reject(new Error('No password was provided.')) })
      return
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = (text) => { if (!muted) rl.output.write(text) }
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer) })
    muted = true
  })
}

async function main () {
  const args = process.argv.slice(2)
  const reset = args.includes('--reset')
  const emailArg = args.find(a => !a.startsWith('--'))
  if (!emailArg) {
    console.error('Usage: node scripts/create-admin.js <email> [--reset]')
    process.exit(2)
  }
  const parsed = emailSchema.safeParse(emailArg)
  if (!parsed.success) {
    console.error(`"${emailArg}" is not a valid email address.`)
    process.exit(2)
  }
  const email = parsed.data

  const config = loadConfig({ ...process.env, ALLOW_DEMO_IN_PRODUCTION: process.env.ALLOW_DEMO_IN_PRODUCTION || 'yes' })
  const db = openDb(config.dbPath)
  const admins = require('../src/repo/admin')(db)
  const existing = admins.getAdminByEmail(email)
  if (existing && !reset) {
    console.error(`An admin with the email ${email} already exists. Add --reset to set a new password.`)
    process.exit(1)
  }
  if (!existing && reset) {
    console.error(`No admin with the email ${email} exists. Run without --reset to create one.`)
    process.exit(1)
  }

  let password = process.env.ADMIN_PASSWORD
  if (!password) {
    password = await promptHidden(`Password for ${email} (at least ${MIN_LENGTH} characters, typing is hidden): `)
    if (process.stdin.isTTY) {
      const again = await promptHidden('Type it again: ')
      if (again !== password) {
        console.error('The two passwords did not match. Nothing was changed.')
        process.exit(1)
      }
    }
  }
  const problem = passwordProblem(password, email)
  if (problem) {
    console.error(`Password not accepted: ${problem}`)
    process.exit(1)
  }

  const hash = await hashPassword(password)
  if (existing) {
    admins.setPassword(existing.id, hash)
    admins.deleteSessionsForAdmin(existing.id)
    admins.audit(null, 'admin.password_reset_cli', 'admin_user', existing.id, null, null)
    console.log(`Password updated for ${email}. Any open sessions were signed out.`)
  } else {
    const id = admins.insertAdmin(email, hash)
    admins.audit(null, 'admin.created_cli', 'admin_user', id, null, { email })
    console.log(`Admin created: ${email}. Sign in at /admin/.`)
  }
  db.close()
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err.message || err)
  process.exit(1)
})

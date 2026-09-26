/**
 * Copy the repo-authored profile layer into $DSH_HOME/profiles/<name>/. The profile's own
 * package.json / lockfile stay untouched — those belong to `dsh plugin`.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const name = process.argv[2] ?? 'verness'
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const target = join(home, 'profiles', name)
if (!existsSync(target)) {
  mkdirSync(target, { recursive: true })
  console.warn(`created ${target} — it has no package.json yet; run:\n  dsh --profile ${name} --from-default-profile headless --dump-config`)
}
const file = 'cordis.patch.yml'
copyFileSync(join('profiles', name, file), join(target, file))
console.log(`synced profiles/${name}/${file} -> ${target}`)

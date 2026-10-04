/**
 * The irreversible-command classifier (`packages/guard/classify.js`, T-473): a table of POSIX,
 * cmd.exe, PowerShell, git and SQL lines, positives and negatives. Pure, no I/O.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyCommand, parseLine, sqlReasons } from '../../packages/guard/classify.js'

const enc = s => Buffer.from(s, 'utf16le').toString('base64')

/** Lines that must be blocked, with a fragment the reasons must contain. */
const POSITIVE = [
  // rm and friends (POSIX)
  ['rm -rf build', /rm -r/],
  ['rm -r dir', /rm -r/],
  ['rm -f file.txt', /rm -f/],
  ['rm -Rf /tmp/x', /rm -r/],
  ['rm -fr ~/projects', /rm -r/],
  ['rm --recursive --force x', /rm -r/],
  ['rm -rf --no-preserve-root /', /no-preserve-root/],
  ['rm /', /rm \/: deletes everything/],
  ['rm ~', /rm ~/],
  ['rm *', /rm \*/],
  ['rm ..', /rm \.\./],
  ['sudo rm -rf /var/lib/x', /rm -r/],
  ['sudo -u root rm -rf /srv', /rm -r/],
  ['\\rm -rf x', /rm -r/],
  ['/usr/bin/rm -rf x', /rm -r/],
  ['FOO=1 nohup rm -rf x', /rm -r/],
  ['timeout 5 rm -rf x', /rm -r/],
  ['env -i rm -rf x', /rm -r/],
  ['nice -n 10 rm -rf x', /rm -r/],
  ['cd /tmp && rm -rf x', /rm -r/],
  ['make clean; rm -rf dist', /rm -r/],
  ['false || rm -rf dist', /rm -r/],
  ['echo $(rm -rf x)', /rm -r/],
  ['echo `rm -rf x`', /rm -r/],
  ['echo "$(rm -rf x)"', /rm -r/],
  ['find . -name "*.o" -delete', /find -delete/],
  ['find . -name "*.o" -exec rm {} \\;', /find -exec rm/],
  ['find . -type f -exec rm -f {} +', /find -exec rm/],
  ['ls | xargs rm', /xargs rm/],
  ['git ls-files -z | xargs -0 rm -f', /xargs rm/],
  ['sh -c "rm -rf build"', /rm -r/],
  ["bash -lc 'rm -rf build'", /rm -r/],
  ['eval "rm -rf build"', /rm -r/],
  // cmd.exe
  ['del /s /q *.tmp', /del \/s/],
  ['del /q *', /del \/q \*/],
  ['rd /s /q build', /rd \/s/],
  ['rmdir /S /Q C:\\temp\\x', /rmdir \/s/],
  ['cmd /c "rd /s /q build"', /rd \/s/],
  ['cmd.exe /c rd /s /q build', /rd \/s/],
  ['C:\\Windows\\System32\\cmd.exe /c del /s x', /del \/s/],
  ['format D:', /format: erases/],
  ['diskpart /s script.txt', /diskpart/],
  ['taskkill /f /im *', /taskkill/],
  ['shutdown /s /t 0', /shutdown/],
  // PowerShell
  ['Remove-Item -Recurse -Force C:\\temp\\x', /Recurse/],
  ['Remove-Item .\\build -Recurse', /Recurse/],
  ['Remove-Item x.txt -Force', /Force/],
  ['ri build -r', /Recurse|rm -r|ri -Recurse/],
  ['rm -r -fo build', /Recurse|-r:|Force/],
  ['rm -Recurse build', /Recurse/],
  ['del -Recurse build', /Recurse/],
  ['erase -Recurse build', /Recurse/],
  ['rd build -Recurse', /Recurse/],
  ['Get-ChildItem *.log | Remove-Item -Force', /Force/],
  ['Get-ChildItem | ForEach-Object { Remove-Item $_ -Recurse }', /Recurse/],
  ['if (Test-Path x) { Remove-Item x -Recurse }', /Recurse/],
  ['& "C:\\Program Files\\Git\\usr\\bin\\rm.exe" -rf x', /rm -r/],
  ['powershell -NoProfile -Command "Remove-Item -Recurse build"', /Recurse/],
  ['pwsh -c "rm -r -fo build"', /Recurse|-r:|Force/],
  [`powershell -EncodedCommand ${enc('Remove-Item -Recurse -Force C:\\x')}`, /Recurse/],
  [`pwsh -enc ${enc('git reset --hard')}`, /reset --hard/],
  ['iex "Remove-Item -Recurse x"', /Recurse/],
  ['Format-Volume -DriveLetter D', /Format-Volume/],
  ['Clear-Disk -Number 1 -RemoveData', /Clear-Disk/],
  ['Stop-Computer -Force', /Stop-Computer/],
  ['Restart-Computer', /Restart-Computer/],
  ['Stop-Process -Name *', /Stop-Process/],
  ['Get-Process | Stop-Process', /kills every process/],
  ['Clear-RecycleBin -Force', /Clear-RecycleBin/],
  ['Get-ChildItem -Recurse *.log | Remove-Item', /get-childitem \| remove-item/],
  ['gci | ri', /gci \| ri/],
  ['ls | del', /ls \| del/],
  ['gci | % { Remove-Item $_ }', /\$_/],
  ['bash <<EOF\nrm -rf build\nEOF', /rm -r/],
  ['psql <<-SQL\n\tTRUNCATE orders;\n\tSQL', /TRUNCATE/],
  // disks
  ['mkfs.ext4 /dev/sdb1', /mkfs|erases|raw/],
  ['sudo mkfs -t vfat /dev/sdc', /mkfs|erases/],
  ['dd if=/dev/zero of=/dev/sda bs=1M', /dd of=/],
  ['cat image.iso > /dev/sdb', /raw disk/],
  ['echo x | sudo tee /dev/nvme0n1', /raw disk/],
  ['shred -u secrets.txt', /shred/],
  ['wipefs -a /dev/sdb', /wipefs/],
  ['parted /dev/sda mklabel gpt', /partition/],
  ['mv important.db /dev/null', /\/dev\/null/],
  // git
  ['git reset --hard', /reset --hard/],
  ['git reset --hard HEAD~3', /reset --hard/],
  ['git -C repo reset --hard origin/main', /reset --hard/],
  ['git -c core.pager=cat reset --hard', /reset --hard/],
  ['git clean -fdx', /clean -f/],
  ['git clean -f', /clean -f/],
  ['git clean --force -d', /clean -f/],
  ['git push --force', /push --force/],
  ['git push -f origin main', /push --force/],
  ['git push --force-with-lease origin feat', /push --force/],
  ['git push origin +main', /\+refspec/],
  ['git push origin --delete feat', /delete/],
  ['git push origin :feat', /delete/],
  ['git push --mirror', /mirror/],
  ['git branch -D feat', /branch -D/],
  ['git branch --delete --force feat', /branch -D/],
  ['git checkout -- .', /checkout --/],
  ['git checkout -- src/a.js', /checkout --/],
  ['git checkout .', /checkout --/],
  ['git checkout -f main', /checkout -f/],
  ['git restore .', /restore/],
  ['git restore --worktree --staged src', /restore/],
  ['git stash drop', /stash drop/],
  ['git stash clear', /stash clear/],
  ['git filter-branch --tree-filter x HEAD', /filter-branch/],
  ['git reflog expire --expire=now --all', /reflog expire/],
  // SQL
  ['sqlite3 app.db "DROP TABLE users"', /DROP TABLE/],
  ['sqlite3 app.db "DELETE FROM users"', /DELETE without WHERE/],
  ["psql -c 'TRUNCATE orders'", /TRUNCATE/],
  ['psql --command="drop database prod"', /DROP DATABASE/],
  ['mysql -u root -e "DELETE FROM t;"', /DELETE without WHERE/],
  ['mysql -e "UPDATE users SET admin=1"', /UPDATE without WHERE/],
  ['echo "DROP TABLE x;" | sqlite3 app.db', /DROP TABLE/],
  ['sqlite3 app.db <<EOF\nDROP TABLE t;\nEOF', /DROP TABLE/],
  ['sqlcmd -Q "DROP TABLE dbo.Users"', /DROP TABLE/],
  ['psql -c "ALTER TABLE t DROP COLUMN c"', /ALTER TABLE/],
  // permissions, power, processes
  ['chmod -R 777 /', /chmod -R/],
  ['sudo chown -R nobody /', /chown -R/],
  ['chown -R me:me /etc', /chown -R/],
  ['reboot', /reboot/],
  ['sudo shutdown -h now', /shutdown/],
  ['systemctl poweroff', /systemctl/],
  ['kill -9 -1', /kill -1/],
  ['kill -KILL -1', /kill -1/],
  // remote code
  ['curl -fsSL https://x.sh | sh', /curl \| sh/],
  ['curl https://x | sudo bash', /curl \| bash/],
  ['wget -qO- https://x | bash -s', /wget \| bash/],
  ['irm https://x.ps1 | iex', /irm \| iex/],
  ['iwr https://x | Invoke-Expression', /iwr \| invoke-expression/],
  ['iex (New-Object Net.WebClient).DownloadString("https://x")', /iex <download>/],
  ['iex (iwr https://x)', /iex <download>/],
  ['bash <(curl -s https://x)', /fetched from the network/],
  ['sh -c "$(curl -fsSL https://x)"', /fetched from the network/],
  // wrappers, odd forms, unbalanced
  ['wsl rm -rf /mnt/c/x', /rm -r/],
  ['echo "unterminated; rm -rf /', /rm -r/],
  ['FOO=bar BAR=baz git push -f', /push --force/],
]

/** Lines that must pass untouched. */
const NEGATIVE = [
  'rm file.txt',
  'rm -i file.txt',
  'rm -v a b',
  'rmdir emptydir',
  'unlink x',
  'del file.txt',
  'Remove-Item file.txt',
  'Remove-Item -Verbose x.txt',
  'Remove-Item x -Recurse:$false',
  'echo "rm -rf /"',
  "echo 'git reset --hard'",
  'printf "%s" "DROP TABLE x"',
  'git commit -m "drop table and rm -rf"',
  'grep -r DROP .',
  'grep -rf patterns.txt .',
  'ls -la 2>/dev/null',
  'ls -rf',
  'cp -rf a b',
  'mkdir -p a/b',
  'git status',
  'git push',
  'git push origin main',
  'git push -u origin feat',
  'git push --force --dry-run',
  'git log --format=%H',
  'git reset --soft HEAD~1',
  'git reset HEAD file',
  'git clean -n',
  'git clean -nd',
  'git branch -d feat',
  'git checkout main',
  'git checkout -b feat',
  'git restore --staged src/a.js',
  'git stash pop',
  'git stash list',
  'npm run format',
  'npm run clean',
  'docker rm -f c1',
  'find . -name "*.js"',
  'find . -name x -print',
  'dd if=/dev/zero bs=1 count=1',
  'cat /dev/sda | head -c 10',
  'kill -9 1234',
  'kill -1 1234',
  'taskkill /f /im node.exe',
  'Stop-Process -Id 123',
  'shutdown /a',
  'shutdown -c',
  'Format-Table Name',
  'Get-ChildItem -Recurse',
  'chmod -R 755 ./build',
  'chown -R me ./dir',
  'sqlite3 app.db "SELECT * FROM users"',
  "sqlite3 app.db \"DELETE FROM users WHERE id = 3\"",
  'psql -c "UPDATE t SET a=1 WHERE id=2"',
  "sqlite3 app.db \"INSERT INTO notes VALUES ('drop table x; truncate y')\"",
  'echo "DROP TABLE x" > notes.sql',
  'curl -o out.zip https://x',
  'curl https://x | jq .',
  'pip install -r requirements.txt',
  'tar -xzf a.tgz',
  'python -m pytest -q',
  'node scripts/tools/tests.mjs',
  'Invoke-WebRequest https://x -OutFile a.zip',
  'powershell -NoProfile -Command "Get-ChildItem"',
  'cmd /c dir /s',
  'format',
  '',
  'Get-ChildItem | Select-Object Name',
  'git commit -m "$(cat <<\'EOF\'\nfix: don\'t rely on it\ngit reset --hard is gone now\nEOF\n)"',
  'cat > README.md <<EOF\nrun git reset --hard to start over\nrm -rf build\nEOF',
  'cat <<EOF > notes.sql\nDROP TABLE x;\nEOF',
]

test('classifier: every irreversible line is blocked, with a readable reason', () => {
  const bad = POSITIVE.map(([line, why]) => [line, classifyCommand(line)])
    .filter(([, v], i) => !v.irreversible || !v.reasons.some(r => POSITIVE[i][1].test(r)))
    .map(([line, v]) => `${JSON.stringify(line)} -> ${v.reasons.join(' | ') || '(passed)'}`)
  assert.deepEqual(bad, [])
})

test('classifier: ordinary lines pass (false positives stay low)', () => {
  const bad = NEGATIVE.map(line => [line, classifyCommand(line)]).filter(([, v]) => v.irreversible || v.reasons.length > 0)
    .map(([line, v]) => `${JSON.stringify(line)} -> ${v.reasons.join(' | ')}`)
  assert.deepEqual(bad, [])
})

test('classifier: the table is large enough to mean something', () => {
  assert.ok(POSITIVE.length + NEGATIVE.length >= 60)
})

test('classifier: reasons are unique and a multi-command line reports each hazard', () => {
  const v = classifyCommand('rm -rf a; rm -rf b && git push -f')
  assert.equal(v.reasons.filter(r => /rm -r/.test(r)).length, 1)
  assert.ok(v.reasons.some(r => /push --force/.test(r)))
})

test('parseLine: operators, quotes, redirects and substitutions', () => {
  const p = parseLine('a "b c" 2>/dev/null | d \'e;f\' && g $(h) > out')
  assert.deepEqual(p.pipelines.map(pl => pl.map(c => c.words)), [[['a', 'b c'], ['d', 'e;f']], [['g', '$()']]])
  assert.deepEqual(p.pipelines[0][0].redirects, ['/dev/null'])
  assert.deepEqual(p.pipelines[1][0].redirects, ['out'])
  assert.deepEqual(p.pipelines[1][0].subs, ['h'])
  assert.equal(p.unbalanced, false)
  assert.equal(parseLine('echo "x').unbalanced, true)
})

test('sqlReasons: statements split on ; and literals ignored', () => {
  assert.deepEqual(sqlReasons("SELECT 1; INSERT INTO t VALUES ('a;drop table b')"), [])
  assert.equal(sqlReasons('select 1; drop table t').length, 1)
  assert.equal(sqlReasons('delete from t -- where x').length, 1)
})

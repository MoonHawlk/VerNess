# 15 — The command guard: irreversible commands are confirmed twice

> Task **T-473**. Status: **built (`packages/guard`, the REPL's `!cmd`, `/guard`).**

The rule: a shell command that cannot be undone (`rm -rf`, `git reset --hard`, `DROP TABLE`,
`format D:`, `curl ... | sh`, ...) is shown to the user in full, with the reasons, and must be
confirmed **twice** before it runs. Nothing auto-approves it.

## What is classified

`classifyCommand(line)` in `packages/guard/classify.js` is pure. It splits the line like a shell would:
quotes, `;` `&&` `||` `|` `&`, `$(...)`, backticks, `<(...)`, redirects and PowerShell script blocks.
It also peels off wrappers (`sudo`, `env`, `nohup`, `timeout`, `nice`, `xargs`, `VAR=x`) and
classifies nested text: `sh -c`, `eval`, `cmd /c`, `powershell -Command` / `-EncodedCommand`,
`iex` and `wsl`. Every dialect is checked on every line.

| Family | Blocked |
|---|---|
| Delete | `rm` with `-r`/`-f` (any target), `rm /`, `~`, `*`, `..`; `find -delete`, `find -exec rm`, `xargs rm`; `del /s`, `del /q *`, `rd /s`, `rmdir /s`; `Remove-Item -Recurse` or `-Force` and its aliases (`ri`, `rm`, `del`, `erase`, `rd`); `shred`, `sdelete`, `Clear-RecycleBin` |
| Disks | `format X:`, `Format-Volume`, `Clear-Disk`, `mkfs*`, `dd of=`, `diskpart`, `fdisk`/`parted` (except listing), `wipefs -a`, writes to `/dev/sd*`, `/dev/nvme*`, `\\.\PhysicalDrive*` |
| git | `reset --hard`, `clean -f` (not `-n`), `push --force`/`-f`/`--force-with-lease`/`+ref`/`--delete`/`--mirror`, `branch -D`, `checkout -- <path>`/`checkout .`/`-f`, `restore <path>` (not `--staged`), `stash drop`/`clear`, `filter-branch`, `reflog expire`, `gc --prune=now` |
| SQL (in `sqlite3`, `psql -c`, `mysql -e`, `sqlcmd -Q`, piped `echo`, heredocs) | `DROP`, `TRUNCATE`, `ALTER TABLE ... DROP`, `DELETE` / `UPDATE` without `WHERE` |
| System | `chmod`/`chown -R` on `/` or a system directory; `shutdown`, `reboot`, `Stop-Computer`, `Restart-Computer`; `kill -9 -1`, `taskkill /im *`, `Stop-Process *` |
| Remote code | `curl`/`wget`/`iwr`/`irm` piped into `sh`/`bash`/`iex`/...; `bash <(curl ...)`; `iex (iwr ...)` |

These pass: `rm file.txt`, `git push`, `echo "rm -rf /"`, `git commit -m "drop table"`, `docker rm -f`
and `npm run format`. The table in `scripts/test/guard.classify.test.mjs` has about 200 positive and
negative lines. If a quote is never closed, the line is checked again with the quotes removed, so it
cannot pass as safe by accident.

## Where it is enforced

- **Model tool calls.** `@finess/guard` listens on `tools/pre-execute` for `bash`, `pwsh` and
  `terminal_send`. `run_code`'s nested calls pass the same gate. The guard lets the other gates
  decide first, so a call that `tool-policy` denies never prompts. Channels are tried in this order:
  1. **Approval service.** The substrate's approval service (`ctx.get('approval')`) gets two
     sequential asks: "1 of 2", then "2 of 2". The web UI's approval panel answers them.
  2. **Controlling terminal.** If nobody answers (`unavailable`: the headless `dsh run`), or the
     session's approval policy is `never`, the guard uses the terminal: `\\.\CONIN$`/`CONOUT$` on
     Windows, `/dev/tty` on POSIX, read synchronously. The first prompt asks you to type `yes`. The
     second asks you to type `DELETE` or the command's first word. Any other answer blocks the call.
  3. **Deny.** If neither channel is available (no console, CI, the web surface without an approval
     answer), the call is refused.

  The model reads `blocked: irreversible command not confirmed by the user (...)`. Commands are
  printed with control characters and ANSI escapes made visible, so they cannot be disguised.
- **The REPL's `!cmd` / `!!cmd`.** These use the same classifier and the same two prompts on the
  terminal. A piped REPL refuses irreversible lines.
- **`/guard`** shows the mode. `/guard check <line>` shows the verdict and reasons without running
  anything.

## Configuration

The row lives in `finess.config.json` under `settings.plugins`:

```jsonc
{ "id": "finess-guard", "package": "@finess/guard", "path": "packages/guard", "enabled": true,
  "surfaceConfig": true, "config": { "irreversible": "confirm-twice" } }
```

`irreversible` takes one of two values:

- `"confirm-twice"` is the default. Any value other than `"deny"` means this.
- `"deny"` refuses irreversible commands without asking.

There is no "allow" value. The REPL reads the same row. `surfaceConfig` writes `surface: web|headless`
into the row config, and the web surface never falls back to a terminal. `FINESS_GUARD_TTY=none` turns
off the terminal channel; it can only make the guard deny.

## Known limits

- `terminal_send` with `submit: false` can build a command across several calls. Each call is
  classified separately.
- Parallel `/team` runs share one console, so their prompts can appear together. Each prompt reads its
  own line.
- The guard reads command text. A script file the model wrote and then runs (`bash x.sh`) is not
  opened. The sandbox (`/access`) is the boundary for that.

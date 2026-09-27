# ADR-0011 — Web commands bridge through the launcher

- Status: accepted
- Date: 2026-09-27
- Design: [`superpowers/specs/2026-09-26-web-commands-bridge-design.md`](../superpowers/specs/2026-09-26-web-commands-bridge-design.md)

## Context
The quick-tools (`/cost`, `/usage`, `/persona`, `/agents`, `/decide`, persona commands such as
`/testplan`, ...) run inside the launcher and worked only in the terminal REPL. The web UI's
message bar has its own slash-command registry (`@deepseek-ai/dsh-commands`, the `commands`
service): a command registered there with `ctx.commands.register` is listed when the user types `/`
and runs on the host without reaching the model. We wanted the quick-tools there too, with no
second implementation of any command.

## Decision
1. **One plugin runs the launcher.** `@verness/commands` (`packages/commands`, plain ESM like the
   spike) registers each web-enabled quick-tool as a host command whose handler spawns
   `node scripts/verness.mjs /<name> <args>` (no shell, `stdin` ignored, `NO_COLOR=1`,
   `VERNESS_NO_PET=1`) and maps exit 0 to `success`, anything else to `error`, with stdout and
   stderr in order and ANSI escapes stripped. The UI's abort signal kills the child; there is no
   fixed timeout. Every command keeps its one implementation and the launcher-built context.
2. **The launcher publishes its list.** `node scripts/verness.mjs --list-commands` prints JSON
   (`name`, `summary`, `usage`, `aliases`, `web`), aliases folded into their command, for the
   active persona. A command opts out of the web with `web: false`: `new`, `resume`, `web`/`ui`,
   `off`, `help` (and `exit`/`quit` where present). A `/`-prefixed word that names no command now
   exits non-zero instead of becoming a model task, so a stale web registration can never start a
   task inside the server.
3. **Register after startup, never over the substrate.** Registration waits for the launcher's
   `appReady.onReady` (there is no cordis `ready` event in cordis 4), so every substrate host command
   is registered first; a name that throws "already registered" is skipped and logged. On top of
   that, a fixed **reserved-name list** is never registered (see Spike, point b).
4. **Web profile only.** A `settings.plugins` row may carry `"surfaces": ["web"]`; `sync` renders
   one patch per profile and leaves such a row out of the headless profile's patch (and setup does
   not install it there). The row's `config.repo` (the checkout's absolute path, which the plugin
   needs because pnpm installs it as a copy) is written only into the profile copies under
   `$DSH_HOME`, never into the committed `profiles/<name>/cordis.patch.yml`.
5. **State changes need a restart.** `/persona`, `/api`, `/models` and `/access` update state and
   the patch, but the running server read both at boot; when they are called with arguments (a
   bare call only shows state), the plugin appends
   `restart the web UI to apply (./turn_on.sh off, then web)` to their reply.
6. **Replies keep the REPL's layout.** Leading blank lines and trailing whitespace are removed, but
   indentation stays, so tables line up as in the terminal.

## Spike (T-374, 2026-09-27, Windows, dsh 0.1.7-rc.2, temporary `DSH_HOME`)
A one-command version of the plugin was mounted in both profiles and probed through the web host's
own Remote API (`POST /api/session/create`, `POST /api/commands/list`, the calls the browser makes).
- **(a) listed — confirmed.** `commands/list` for a web session returned our `vnping` beside the
  substrate's `compact`, `export`, `feedback`, `goal`, `permission` and `plan`. That list is what the
  web UI's `/` menu is built from.
- **(b) `/model` left to the substrate — failed as designed, fallback applied.** cordis 4 has no
  `ready` event; `appReady.onReady` fires after the substrate's host command plugins (a `feedback`
  registration threw "already registered" and was skipped). But the web `/model` is not a host
  command: it is a *client* contribution (`dsh-client-ui-model-selection`, likewise `/file` from
  `ui-conversation`). A host `model` registration therefore succeeds (it appeared in
  `commands/list`), and the client's menu builder throws
  `ui-commands: contribution /model collides with a host command`, which would break the `/` menu.
  `compact` also registered without error (the substrate registers its own per agent, which shadows
  ours). Neither case is detectable from the host, so the design's fallback applies: the plugin
  never registers the reserved names `model`, `file`, `compact`, `export`, `feedback`, `goal`,
  `permission`, `plan`, read from the pinned substrate. No dsh-web-all package registers a command.
- **(c) headless does not apply the plugin — failed, fallback applied.** The headless profile mounts
  the `commands` service too; the plugin applied and registered on every headless run. Fallback:
  the `surfaces: ["web"]` row field and a per-profile patch render (decision 4).

## Consequences
- About 0.2 s of node start per command, and one `--list-commands` run (5 s cap) at web boot.
- Persona commands follow the persona active at web boot; after `/persona` the list is stale until
  the restart the reply asks for. A stale command that no longer exists answers with an error.
- Arguments are split on whitespace, as in the REPL; quotes do not group words.
- The reserved-name list must be re-checked when the substrate pin moves (`scripts/test/`
  compares it with the pinned upstream when the submodule is present).
- A command that prompts gets a closed stdin; `/dd label` refuses ("labelling needs a terminal").
- Cancelling kills the launcher child; on Windows a grandchild it started (a `/team` dsh run) may
  outlive it.
- End to end (2026-09-27, temporary `DSH_HOME`, port 3181): the web session's `commands/list` held 33
  VerNess entries (commands and aliases) beside the substrate's six host commands and no `model` of
  ours; `/cost`, `/usage`, `/persona`
  and `/agents` replied with the same text as the terminal launcher.

# profiles/finess

The FiNess profile. `package.json` in `$DSH_HOME/profiles/finess/` is owned by the `dsh plugin`
command (it runs pnpm there); this directory holds only what we author by hand:

- `cordis.patch.yml` — our patch layer (the insert rows that mount FiNess plugins).

Sync it with `npm run profile:sync` after every change, then verify with
`dsh --profile finess --dump-config`.

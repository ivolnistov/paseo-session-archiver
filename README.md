# session-archiver (Paseo plugin, lab candidate)

Soft-archives helpers whose current result was explicitly marked consumed, and primary chats idle
for 7 days. Preview by default; archive mode is blocked until versioned Docker readiness evidence
is attested. This is an experimental development snapshot. Docker integration acceptance is incomplete; known issues remain.
Readiness must not be attested until the required checks pass. Publication does not install or enable the plugin.

## Dependencies are prepared first, from your approved registry
The manifest preparation step is offline by design:
`npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund`. It never contacts a registry;
with an empty npm cache it fails with `ENOTCACHED` instead of falling back to the network.
Prefetch the pinned runtime closure (lockfile, integrity-checked, no lifecycle scripts) as the
daemon's user, from the approved registry, before installing:

```sh
cd /absolute/path/to/session-archiver
npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  --registry='<your-approved-registry-url>' \
  --cache "$(npm config get cache)"        # the daemon user's npm cache
npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund   # dry check: must succeed
```

Only then, and only with authorisation for that host, `paseo plugin install <path>`; the daemon runs
the same offline command. Do not change the daemon's npm configuration. Packages missing from the
approved registry are uploaded through its vetting workflow, never fetched elsewhere.

## Checks
All typecheck, tests and integration run in Docker: `docker/README.md`.
Admin CLI (after dependencies are installed): `npm run admin -- --url ws://127.0.0.1:6767/ws
--data-dir <plugin dataDir> <mark-consumed <id>|preview|pause|resume|status>`; usage is in the
`admin/cli.ts` header.

## Known limits in this snapshot

- Descendant state is based on the pass-start inventory, so a newly created child can be missed before archiving a parent.
- A pause issued during a pass is not rechecked between archive actions.
- RPC context lifetime, real-daemon restore, heartbeat coverage and autonomous startup still require integration verification.
- Unit tests do not establish readiness for archive mode. Keep preview mode until the checks in `docker/README.md` pass.

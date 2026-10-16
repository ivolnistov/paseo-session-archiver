# Session archiver: isolated Docker checks

Every runnable check for this plugin runs here. Nothing in this directory talks to the host daemon.

## Boundaries
- No host bind mounts, no `~/.paseo`, no credentials, no `docker.sock`. Sources are copied into the
  image at build time; rebuild after each change.
- Runtime `network_mode: none` for both services; no published ports. The only network use is
  `npm ci` / `npm install -g @getpaseo/cli@0.11.1` during build, through `NPM_REGISTRY`.
- `NPM_REGISTRY` has no default. Use your approved package registry. A version your registry lacks is
  uploaded through your package-vetting workflow, never re-pointed at npmjs.
- The daemon's `PASEO_HOME` is a container tmpfs: config, agents, journal and consumption store
  vanish with the container. Providers: only a deterministic mock/stub configured inside the
  container. No paid model calls, no provider credentials.
- Coordinator verifies `docker context show` (expected local engine, not NAS/remote) before running.

## Validation status

Only partial unit and typecheck evidence exists for the laboratory version. Integration readiness is incomplete.
Dependency availability depends on your approved registry; no registry or credentials are configured by this repository.
Resource limits per service: 2 CPUs, 2 GiB memory (no swap), 256 pids.

## Commands (run from the repository root)
```sh
docker context show
export NPM_REGISTRY='<your-approved-registry-url>'
docker compose -f docker/compose.yaml build check
docker compose -f docker/compose.yaml run --rm check          # typecheck, then tests/*.test.ts if present
docker compose -f docker/compose.yaml build daemon
docker compose -f docker/compose.yaml up -d daemon
docker compose -f docker/compose.yaml exec daemon sh           # integration work happens in here
docker compose -f docker/compose.yaml down -v                  # discard all container state
```

## Readiness checks inside the daemon container (test role, in order)
Record each result with a run id; the evidence string format is `docker:YYYY-MM-DD:<run id>`.
1. Start the container daemon and confirm `paseo --version` = 0.11.1. Discover the start command and
   the mock/stub provider setup from `paseo --help` inside the container; `mock-load-test-agent.js`
   and `generic-acp-agent.js` exist in the 0.11.1 server package, but enabling them is unverified.
2. `paseo plugin install /work/session-archiver` against the CONTAINER daemon only; enable plugins
   in the container config; confirm `paseo plugin logs session-archiver` shows `loaded`.
3. Outcome identity (`turnBumpsUpdatedAtEvidence`): create a parent and a helper; let the helper
   finish; record `updatedAt`; trigger (a) a new prompt, (b) a provider-initiated turn if the stub
   can produce one, (c) a label write. Each must change `updatedAt` or `lastUserMessageAt`.
4. Heartbeat coverage (`heartbeatEvidence`): create a heartbeat for the helper; confirm
   `paseo schedule ls --json` lists it and `schedule inspect <id> --json` shows a `self`/`agent`
   target with that agent ID. Confirm the exact inspect argument form.
5. Archive/restore (`restoreEvidence`): on one disposable mock-provider agent, archive via the plugin
   adapter path (`agents.ref(id).archive()`), confirm `archivedAt`, restore through the daemon's
   supported path (to be identified in-container; daemon has `unarchiveSnapshot`), confirm the
   timeline/history is intact. Record the exact restore command.
6. Autonomous startup on an idle daemon: fresh container, no agents, no app connection. Install the
   plugin, set `startupDelayMinutes: 1` in the container's settings, restart the container daemon,
   wait; the journal must show `bootstrap:standalone` then a preview `pass` row. No model calls.
   The image warms the npm cache so the manifest build runs with `NPM_CONFIG_OFFLINE=true`.
7. Preview pass with the default settings; confirm journal rows carry only allowlisted keys.
Only after all evidence exists may an operator attest readiness for the exact plugin version in the
settings screen. Host activation is a separate, owner-authorised step.

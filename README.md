# subZ

**A subscription tracker with a fuse.**

Track any recurring payment — streaming, utilities, rent, a friend's shared
account, an API key you keep meaning to rotate out. Before each renewal you
actively **keep** it, or it **burns**: subZ deletes its own record
automatically, and that deletion is your cue to go cancel the real thing.

Nothing here is a subscription-management or auto-cancel service. Burning
the fuse does **not** cancel your actual subscription with the provider —
it only deletes subZ's local record of it. Every subscription stores a
`cancel_url` that just opens the provider's own cancellation page; you still
click through and cancel it yourself. subZ's job is to make sure you
*remember to*, by defaulting to silence-deletes instead of silently
recurring forever.

Store a subscription and, optionally, its account notes or API key; the key
is sealed in your browser with a vetKey the canister never sees — the
canister only ever stores ciphertext. Every subscription has a fuse — if you
don't extend it before the deadline, the hourly expiry monitor deletes it,
key and all. Purges are recorded in an on-canister log, and the canister can
threshold-sign a purge receipt proving what was deleted. Friends can also
claim a seat in a shared subscription's split-cost session over a paid
inter-canister route, and an optional per-subscription ICP pot can fund a sub
and pay out on keep (see [Known limitations](#known-limitations) below).

## How it works

- **vetKeys (`keys` slot)** — the symmetric vault key is derived only in the
  browser, encrypted to a one-use transport key. API keys are AES-256-GCM
  sealed in the tile before `add_subscription` sends anything to the backend.
- **Managed memory (`subz` root)** — subscriptions, purge log, and policy
  persist across canister self-upgrades.
- **scheduled_tasks (`expiry_monitor`)** — an hourly internal task sweeps and
  deletes expired subscriptions when auto-delete is on.
- **chain_key_signing (`purge_receipts`)** — the canister threshold-signs a
  bounded assertion of the purge state; verifiable against the subnet key.

The pitch: credentials you stopped paying for shouldn't live forever on
someone's replicated state. subZ makes expiry the default — silence deletes.

## Build (inside the Neutron repository)

This app uses the repository workflow. Place it at `apps/subz` in a clone of
https://github.com/infu/neutron, then from the repo root:

```sh
npm install
npm --workspace neutron-subz run package
npm --workspace neutron-subz test
```

The archive lands at `apps/subz/subz.v0.1.0.neutron`. Add it to a copy of
`local.ndeploy.json` under `artifacts.packages`, then:

```sh
npm run provision -- my.ndeploy.json serve      # terminal 1
npm run provision -- my.ndeploy.json reinstall  # terminal 2
npm run provision -- my.ndeploy.json status
```

Or install the archive through the launcher's reviewed File/URL flow.

Requires Bun and Mops on `PATH`; no host `moc` needed.

**These `package`/`test`/`build` scripts only work nested inside the Neutron
monorepo.** Every one of them shells out to a sibling package by relative
path (e.g. `bun ../../packages/neutron-scripts/src/validate.ts`), and
`package.json`'s own `neutron-design-system`/`neutron-tools` dependencies
resolve to sibling workspace packages, not anything on the npm registry. Run
from a standalone checkout of just this app (not nested at `apps/subz`) and
`npm run test`/`npm run package` fail immediately at the first `validate`
step with `Module not found "../../packages/neutron-scripts/src/validate.ts"`.
If you need to sanity-check this repo on its own, the `sass` CLI check above
is the one thing that works standalone — everything else needs the real
monorepo layout.

Sanity-check the SCSS on its own (no dev server exists yet — see
[Using this app](#using-this-app-development) for why) with the `sass` CLI,
pointing `--load-path` at wherever `neutron-design-system` lives in your
checkout of the Neutron repository:

```sh
npx sass --load-path=../../packages src/style.scss /tmp/subz.css
```

## Using this app (development)

subZ ships as a package inside the Neutron monorepo, not as a standalone
npm project — `package.json`'s `neutron-design-system` and `neutron-tools`
dependencies resolve to sibling packages in that repo's workspace, not to
anything published on npm. There is no `npm run dev`; `npm run watch` runs
`bun build.ts watch` for an incremental esbuild rebuild, and `npm run
package` is the full validate → build → mops-pack → schema → archive
pipeline described above.

**Two ways to integrate against subZ's backend** — see
[`docs/api.md`](docs/api.md) for the full reference:

1. **Raw candid**, either self-called from subZ's own tile
   (`querySelf`/`updateSelf`/`callSelfDialog` from `neutron-tools/app`) or,
   for the one public route, called by a friend's canister claiming a split
   seat (`subz_split_v1/join` → `split_join`).
2. **Agent tools** (`subz_list`, `subz_keep`, `subz_track`), implemented in
   `src/background.ts` via `exposeTool`. These wrap a subset of the candid
   methods behind a JSON tool schema for LLM/automation callers — they are a
   convenience layer, not a superset of the candid API.

There is no `.did` file in this repo; `docs/api.md` is generated by reading
`backend/main.mo`'s own `{method}_Input`/`{method}_Output` manifest (the
authoritative Candid signature source) together with `neutron.json`'s `func`
block, which is also where the "self-call argument count does not match live
Candid interface" bug class — seen during hackathon judging and reported
fixed — would resurface if the two ever drift out of sync. See
[`docs/api.md`'s Conventions section](docs/api.md#conventions) for details.

## Known limitations

- **ICP payment pots don't work yet with the Wallet app installed.** The
  Wallet app reserves the *entire* ICP ledger principal for itself
  (a principal-wide reservation). subZ only requests a narrower `exact`
  reservation on two specific ledger methods
  (`icrc1_balance_of`/`icrc1_transfer`, see `neutron.json`). Wallet's
  broader reservation shadows subZ's narrower one, so with Wallet installed,
  `vault_balance` and `pay_now` currently can't reach the ledger at all —
  this is a platform-level reservation-priority conflict, not a bug in
  subZ's own code, and it isn't resolved by anything in this repo. Treat the
  optional pot/payment feature as **not currently functional** whenever
  Wallet is installed alongside subZ, rather than assuming it works because
  the UI is present.
- **`cancel_url` is a link, not an integration.** subZ does not call any
  provider's API and cannot cancel a real subscription on your behalf.
  Burning a fuse only deletes subZ's own record.
- **No per-user access control inside the canister.** Every method in
  `backend/main.mo` is reachable by whatever the Neutron kernel's
  self-call/ingress/agent-entrypoint permission layer allows — there's no
  owner-principal check in the Motoko code itself. See
  [`docs/api.md`](docs/api.md#no-caller-side-auth-in-the-canister--permissions-live-in-neutronjson)
  for the full permission surface.

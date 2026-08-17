# subZ

A self-destructing subscription vault for Neutron. Store a subscription and
its API key; the key is sealed in your browser with a vetKey the canister
never sees. Every subscription has a fuse — if you don't extend it before the
deadline, the hourly expiry monitor deletes it, key and all. Purges are
recorded in an on-canister log, and the canister can threshold-sign a purge
receipt proving what was deleted.

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

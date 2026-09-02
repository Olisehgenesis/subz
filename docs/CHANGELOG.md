# Changelog

All notable changes to subZ are recorded here. Dates are when the change was
made in this repository, not necessarily when it was deployed.

## v0.3.0 — Visual polish, API docs, first-run demo (2026-09-02)

This pass targeted the first-impression/judging experience: judges reported
the app looked plain on first open and had nowhere near the visual polish of
its actual technical depth (vetKeys, threshold signing, inter-canister
split-cost payments). Nothing in this release touches the canister — it's
frontend styling, documentation, and a client-side-only demo preview.

### Visual overhaul (`src/style.scss`)

- Reworked the fuse/countdown visuals — the emotional core of the pitch —
  so the three urgency states (`ok` / `warning` / `danger`) read clearly at
  a glance: a glowing ember-cap on the fuse bar that intensifies as a
  subscription nears its burn date, a pulsing danger-state glow on the bar
  itself, and a hero countdown that escalates into a tonal warning/danger
  panel instead of staying a flat number.
- Subscription cards gained real hierarchy: rounded panels, hairline
  elevation shadows, a top accent bar colored by urgency state, hover/focus
  lift, and bumped type scale on the name/countdown.
- Polished the empty state, category filters, template picker, dialogs,
  toasts, and split-session/pot rows for consistent spacing, hover/focus
  states, and enter/exit animations.
- Extended `prefers-reduced-motion` handling to cover every new animation.
- All of this was built **inside** the existing `neutron-design-system`
  tokens (dark-mode only, no gradients, no remote fonts, ≤4px radii,
  hairline separators) rather than introducing a parallel design language.
- No DOM structure, class hooks, or component logic changed — this was a
  styling-only pass.

### API reference (`docs/api.md`, new)

- Documented every public method on the `backend/main.mo` canister: purpose,
  input/output types, validation limits, side effects, and which call
  surface reaches it (self-call, public ingress, or neither).
- Explained the two integration surfaces (raw candid vs. the `subz_list` /
  `subz_keep` / `subz_track` agent tools) and how they differ.
- Documented Neutron-kernel-specific call conventions: kernel-injected
  arguments (`caller`, `task_capabilities`) that aren't part of the candid
  input tuple, and how a mismatch there produces the "self-call argument
  count does not match live Candid interface" error class reported during
  judging (reported fixed; this doc explains the mechanism so it's easier to
  diagnose if it recurs).
- Called out plainly that `pay_now` and `vault_balance` cannot currently
  reach the ICP ledger when the Wallet app is installed, because Wallet's
  principal-wide ledger reservation shadows subZ's narrower `exact`-scoped
  reservations — a platform-level conflict, not a subZ bug.
- No `.did` file was invented; the `_Input`/`_Output` manifest already
  generated at the bottom of `main.mo` remains the source of truth.

### README expansion

- Sharpened the "subscription tracker with a fuse" pitch and made explicit
  that burning a subscription in subZ never cancels the real one — it only
  deletes subZ's own record; `cancel_url` is just a link to the provider.
- Added a "Using this app (development)" section linking the API reference
  and explaining the two integration surfaces.
- Added a "Known limitations" section: the Wallet/ICP-ledger reservation
  conflict, `cancel_url` being a link and not an integration, and the lack
  of per-user access control inside the canister itself (permissions are
  entirely kernel-side, via `neutron.json`).

### First-run demo preview (`src/index.tsx`, `src/style.scss`)

- Added a **"Show me an example"** button to the empty state. Clicking it
  renders three example subscription cards (Netflix, Electricity, Gym —
  drawn from the existing `SERVICE_TEMPLATES`) tuned to sit in each of the
  three urgency states: healthy (~20 days left), warning (~6 hours left),
  and danger (already past due, awaiting the hourly sweep — the one state a
  real `add_subscription` call can't produce on demand, since renewal has a
  1-day floor).
- **Client-side only.** These are plain rendering-layer objects; the preview
  never calls `add_subscription` or any other canister method, so it cannot
  pollute a user's real vault. Cards are visually marked with an "example"
  ribbon and a "not saved" badge, and the whole preview is auto-dismissed
  the moment a real subscription is tracked (and can also be dismissed
  manually).
- No changes to `backend/main.mo` or `neutron.json`.

### Validation notes for this release

- `src/style.scss` was validated by compiling it standalone with the `sass`
  CLI against the `neutron-design-system` package (see the README's "Build"
  section for the exact command). It was not validated in a running
  browser in this environment.
- The `src/index.tsx` demo-preview change was type-checked with a
  best-effort standalone `tsc` invocation and produces the same five
  pre-existing, environment-only errors (missing `neutron-tools/app` and
  `*.scss` ambient type declarations, both resolved normally only inside the
  real monorepo checkout) as the unmodified file on the same commit —
  i.e. the new code introduces zero additional type errors.
- `npm run build`, `npm run package`, and `npm run test` could not be run to
  completion in this standalone worktree — see the "Build" section of the
  README and the accompanying report for exactly why and what to run
  instead inside a real `infu/neutron` checkout.

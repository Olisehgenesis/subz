# subZ API reference

subZ's backend is a single Motoko canister (`backend/main.mo`, module `Init`)
running inside a Neutron app tile. There is **no `.did` file in this repo** —
Neutron generates the live Candid interface from the Motoko source at package
time, using the `{method}_Input` / `{method}_Output` type manifest at the
bottom of `main.mo` (between `/*---NEUTRON GENERATED BEGIN---*/` and
`/*---NEUTRON GENERATED END---*/`) as the authoritative signature list. **This
document is derived directly from that manifest, the method bodies above it,
and `neutron.json`** — treat those three as the source of truth if this
reference and the code ever disagree.

If you're integrating with subZ (as another app, an agent, or a friend's
canister claiming a split seat), read [Conventions](#conventions) first — the
call surface has a couple of Neutron-specific quirks that aren't visible from
the method signatures alone.

## Two ways to integrate

subZ exposes **two distinct call surfaces**. They are not interchangeable:

| Surface | Who uses it | Where it's implemented | Methods available |
| --- | --- | --- | --- |
| **Raw candid, via self-call** | subZ's own frontend tile (`src/index.tsx`) | `querySelf` / `updateSelf` / `callSelfDialog` from `neutron-tools/app` | Any method listed under [Self-calls](#self-calls-preapproved_self_calls) |
| **Raw candid, via public ingress** | A friend's Neutron canister claiming a split-cost seat | Neutron's `public_ingress` router → `split_join` | `split_join` only, at route `subz_split_v1/join` |
| **Agent tools** | LLM agents / automations | `exposeTool` in `src/background.ts` | `subz_list`, `subz_keep`, `subz_track` (JSON-schema wrappers over a subset of the candid methods below) |

Agent tools are **not** a 1:1 mirror of the candid API — they wrap one
candid call each, reshape the input/output into a friendlier JSON schema, and
in `subz_keep`/`subz_track`'s case also trigger a tray-badge resync
(`syncBadge()`) as a side effect that the raw candid method itself does not
perform. If you're building an agent integration, prefer the tools; if you're
building a canister-to-canister integration or need a method the tools don't
cover, use the candid surface directly.

## Conventions

### No caller-side auth in the canister — permissions live in `neutron.json`

`main.mo` methods do **not** check `msg.caller` or any owner-principal
against an allow-list. There is no per-user access control in the canister
code at all. Every method is reachable by whatever principal the *kernel*
lets reach it, and that's gated entirely by `neutron.json`:

- **`preapproved_self_calls`** — the list of methods subZ's own tile/
  background scripts may call via `querySelf`/`updateSelf` without asking the
  user for consent on every single call. See the [table](#self-calls-preapproved_self_calls)
  below for the exact list.
- **`public_ingress.routes`** — the one externally-callable HTTP-adjacent
  route, `subz_split_v1/join`, mapped to `split_join`. Bounded by
  `max_request_bytes`/`max_response_bytes` (256 bytes each) and
  `max_calls_per_hour: 60`.
- **`agent_entrypoints`** — the three agent tool names (`subz_list`,
  `subz_keep`, `subz_track`) that are allowed to be exposed to agent callers
  at all.

`split_join`'s own `caller : Principal` parameter (injected by the kernel,
see below) is accepted but explicitly `ignore`d in the method body — it is
**not** used for authorization today. Don't assume calling with a specific
`caller` value grants or restricts anything at the canister level.

### Kernel-injected arguments are not part of the candid input tuple

Two methods take an extra parameter that a caller never supplies directly —
the kernel injects it:

| Method | Injected arg | Declared in `neutron.json` as |
| --- | --- | --- |
| `split_join` | `caller : Principal` — the calling canister's principal | `"func".split_join.arg: ["caller"]` |
| `expiry_monitor` | `task_capabilities : TaskCapabilities` — scoped backend-call capability for the scheduled task | `"func".expiry_monitor.arg: ["task_capabilities"]` |

The generated `split_join_Input` type is `(request : SplitJoinInput)` — a
**one-element** tuple — even though the Motoko signature takes two
parameters. The second (`caller`) is stitched in by the kernel at dispatch
time, not supplied by the calling canister. Likewise `expiry_monitor_Input`
is `(())`: the task never takes a real argument from a caller, only the
injected capabilities object.

This distinction matters because a `neutron.json` `func` entry that's out of
sync with `main.mo`'s actual parameter list is exactly the failure mode
behind the **"Self-call argument count does not match live Candid
interface"** build error reported during judging. That class of bug has been
reported fixed, but if you see it again: check that every method with an
`arg` entry in `neutron.json`'s `func` block has a matching Motoko signature
where the injected parameter is the **last** positional argument, and that
the `{method}_Input` manifest tuple only lists the *caller-supplied*
parameters, not the injected ones.

### Query vs. update vs. `async*`

- **`query`** methods (`status`, `list_sessions`, `list_subscriptions`,
  `purge_log`, `get_key`) are read-only, don't touch stable memory, and are
  cheap/fast (no consensus round on most read paths).
- **`update`** methods mutate `Memory.Mem` (the `subz` stable memory root)
  synchronously — no `await` inside them, so they're a single atomic step.
- **`async*`** methods (`vault_balance`, `pay_now`, `sign_purge_receipt`)
  make an outbound inter-canister call (to the ICP ledger or the chain-key
  signing subsystem) and are declared `async*` in both Motoko and
  `neutron.json`'s `func` block. These are slower, can fail independently of
  validation, and require a capability reservation (see
  [Pots & payments](#pots--payments) below).
- **`internal`** (`expiry_monitor`) is not callable by any frontend, agent,
  or external canister at all — it only runs as a `scheduled_tasks` entry
  (hourly, `run_on_start: true`), invoked by the Neutron kernel itself.

### Errors are strings, not traps

Every `update` method here returns a `Text` status message (e.g. `"No
subscription with id foo"`) rather than trapping or returning a Candid
`#Err` variant. The two `async*` payment/balance methods are the exception —
they return a record with an explicit `ok : Bool` field
(`PayResult`/`BalanceView`) precisely because a failed ledger call needs to
distinguish "validation rejected this" from "the outbound call itself
failed." Don't parse method output for a Candid error variant on the
`Text`-returning methods; check the returned string.

## Quick reference

| Method | Kind | Self-call preapproved | Agent tool | Purpose |
| --- | --- | --- | --- | --- |
| [`status`](#status) | query | ✅ | via `subz_list` (indirectly) | Vault summary: counts, budget, next expiry |
| [`set_budget`](#set_budget) | update | ✅ | — | Set/clear the monthly budget label |
| [`set_funded`](#set_funded) | update | ✅ | — | Toggle a subscription's funded flag |
| [`create_session`](#create_session) | update | ✅ | — | Open a split-cost session with named seats |
| [`list_sessions`](#list_sessions) | query | ✅ | — | List all split sessions |
| [`mark_seat_paid`](#mark_seat_paid) | update | ✅ | — | Mark a seat paid/unpaid |
| [`close_session`](#close_session) | update | ✅ | — | Close a split session to new joins |
| [`split_join`](#split_join) | update | — (public ingress only) | — | A friend's canister claims a seat |
| [`add_subscription`](#add_subscription) | update | ✅ | ✅ `subz_track` | Track a new subscription |
| [`extend_subscription`](#extend_subscription) | update | ✅ | ✅ `subz_keep` | "Keep it" — reset the fuse |
| [`update_subscription`](#update_subscription) | update | ✅ | — | Edit subscription details (fuse untouched) |
| [`set_payee`](#set_payee) | update | ✅ | — | Set the pot's payout principal |
| [`fund_pot`](#fund_pot) | update | ✅ | — | Record e8s added to a subscription's pot |
| [`vault_balance`](#vault_balance) | update, `async*` | ✅ | — | Read the canister's ICP ledger balance |
| [`pay_now`](#pay_now) | update, `async*` | — (interactive consent only) | — | Pay a pot out to its payee; resets the fuse |
| [`delete_subscription`](#delete_subscription) | update | ✅ | — | Cancel/burn a subscription now |
| [`list_subscriptions`](#list_subscriptions) | query | ✅ | ✅ `subz_list` | List all tracked subscriptions |
| [`purge_log`](#purge_log) | query | ✅ | — | List burn/cancel history |
| [`get_key`](#get_key) | query | ✅ | — | Fetch a subscription's encrypted note ciphertext |
| [`set_policy`](#set_policy) | update | ✅ | — | Toggle auto-burn on expiry |
| [`purge_now`](#purge_now) | update | ✅ | — | Force an immediate expiry sweep |
| [`sign_purge_receipt`](#sign_purge_receipt) | update, `async*` | ✅ | — | Threshold-sign a purge-state assertion |
| [`expiry_monitor`](#expiry_monitor) | internal, `async*` | n/a (scheduled task only) | — | Hourly automatic expiry sweep |

## Types

These are the Candid-visible record/variant types referenced below, taken
directly from `main.mo`'s top-level `public type` declarations.

- **`SubscriptionMeta`** — `id`, `name`, `cost`, `category`, `funded : Bool`,
  `cancel_url`, `has_note : Bool`, `note_bytes : Nat`, `renew_days : Nat`,
  `pot_e8s : Nat`, `payee`, `created_at : Int`, `expires_at : Int`,
  `seconds_left : Int` (clamped to `>= 0`, computed live at read time). This
  is what `list_subscriptions` returns — note there is no separate "get one"
  query; clients filter the list client-side.
- **`AddSubscriptionInput`** — `id`, `name`, `cost`, `category`,
  `funded : Bool`, `cancel_url`, `note_ciphertext : ?Blob`,
  `renew_days : Nat`. `note_ciphertext` is opaque AES-GCM ciphertext sealed
  client-side with vetKeys — the canister never sees a plaintext key.
- **`UpdateSubscriptionInput`** — `id`, `name`, `cost`, `category`,
  `cancel_url`, `renew_days : Nat`. No `funded`/`note_ciphertext`/expiry
  fields — those are changed through other methods, and editing details
  deliberately never touches `expires_at`.
- **`SessionView`** — `id`, `sub_id`, `sub_name`, `seats : [SeatView]`,
  `open : Bool`, `created_at : Int`.
- **`SeatView`** — `member : Text`, `paid : Bool`.
- **`SplitJoinInput`** — `session_id : Text`, `member : Text`.
- **`PurgeEventView`** — `id`, `name`, `purged_at : Int`, `reason : Text`
  (e.g. `"burned — never confirmed"` or `"cancelled by owner"`).
- **`Status`** — `subscription_count : Nat`, `auto_delete : Bool`,
  `monitor_runs : Nat`, `purge_count : Nat`, `next_expiry_in : ?Int`,
  `monthly_budget : Text`.
- **`BalanceView`** — `ok : Bool`, `message : Text`, `balance_e8s : Nat`.
- **`PayResult`** — `ok : Bool`, `message : Text`, `block_index : ?Nat`,
  `pot_e8s : Nat` (the pot's remaining balance after the attempt).
- **`Receipt`** — `ok : Bool`, `error : Text`, `assertion_text : Text`,
  `signature_hex : Text` (hex-encoded, `0x`-prefixed threshold ECDSA
  signature over `assertion_text`).

## Methods

### Status & policy

#### `status`
- **Kind**: query
- **Input**: `()`
- **Output**: [`Status`](#types)
- **Reachable via**: self-call (preapproved)
- Returns vault-wide counters (subscription count, purge count, monitor run
  count, next expiry, current budget label, auto-delete flag). Cheap to poll
  — this is what the tile calls on load alongside `list_subscriptions`.

#### `set_budget`
- **Kind**: update
- **Input**: `monthly_budget : Text` (≤ 32 bytes)
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Sets or clears (`""`) the free-text monthly budget label shown in the
  budget meter. Purely cosmetic — not enforced against actual spend.

#### `set_policy`
- **Kind**: update
- **Input**: `auto_delete : Bool`
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Toggles whether the hourly `expiry_monitor` sweep actually deletes expired
  subscriptions. When off, expired subscriptions are left in place (visible
  as overdue) until manually deleted or the policy is turned back on.

#### `purge_now`
- **Kind**: update
- **Input**: `()`
- **Output**: `Text` — `"Burned N expired subscription(s)"`
- **Reachable via**: self-call (preapproved)
- Forces an immediate expiry sweep regardless of the hourly schedule.
  Ignores `auto_delete` — this is the manual "burn everything overdue right
  now" action.

#### `sign_purge_receipt`
- **Kind**: update, `async*`
- **Input**: `()`
- **Output**: [`Receipt`](#types)
- **Reachable via**: self-call (preapproved)
- **Capability**: `chain_key_signing` (`purge_receipts` slot,
  `ecdsa_secp256k1`, ≤ 4096-byte assertion)
- Builds a plaintext assertion string
  (`subZ purge receipt v1\npurge_count=…\nactive_subscriptions=…\nsigned_at=…`)
  and threshold-signs it via the chain-key signing capability. Returns
  `ok: false` with a human-readable `error` (see `chainKeyErrorText` in
  `main.mo`) rather than trapping if signing is disabled, busy, or the key
  is unavailable — always check `ok` before trusting `signature_hex`.

### Subscriptions (the fuse lifecycle)

#### `add_subscription`
- **Kind**: update
- **Input**: [`AddSubscriptionInput`](#types)
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved), agent tool `subz_track`
- **Validation**: `id` 1–64 bytes and must not already exist; `name` 1–120
  bytes; `cost` ≤ 32 bytes; `category` ≤ 24 bytes; `cancel_url` ≤ 256 bytes;
  `renew_days` 1–3650; `note_ciphertext` if present must be 1–65,536 bytes;
  vault capped at 64 subscriptions total.
- Creates a new subscription with `expires_at = now + renew_days` and starts
  its fuse. `cancel_url` is stored only as a convenience link to the real
  provider's site — **subZ never calls it or cancels anything on your
  behalf**; deleting/burning the record here only removes subZ's own copy.

#### `extend_subscription`
- **Kind**: update
- **Input**: `id : Text`
- **Output**: `Text` — `"Kept {id}"` or `"No subscription with id {id}"`
- **Reachable via**: self-call (preapproved), agent tool `subz_keep`
- The "keep it" action: resets `expires_at` to `now + renew_days`, i.e. the
  fuse re-lights for another full cycle. This is the only method the
  `subz_keep` agent tool wraps.

#### `update_subscription`
- **Kind**: update
- **Input**: [`UpdateSubscriptionInput`](#types)
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- **Validation**: same byte/range limits as `add_subscription` for the
  fields it covers.
- Edits name/cost/category/cancel_url/renew_days for an existing
  subscription. Deliberately **does not** touch `expires_at`, `funded`, or
  `note_ciphertext` — editing details never resets or extends the fuse.

#### `set_funded`
- **Kind**: update
- **Input**: `id : Text`, `funded : Bool`
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Toggles the `funded` display flag on a subscription. Independent of the
  pot balance — this is a manual marker, not derived from `pot_e8s`.

#### `delete_subscription`
- **Kind**: update
- **Input**: `id : Text`
- **Output**: `Text` — `"Cancelled {id}"` or an error string
- **Reachable via**: self-call (preapproved)
- Manually burns a subscription immediately (the user-initiated "cancel"
  path, as opposed to the automatic expiry sweep). Records a
  `"cancelled by owner"` purge-log entry. **This only deletes subZ's own
  record** — it does not reach out to the real subscription provider in any
  way; that's what the `cancel_url` link is for.

#### `list_subscriptions`
- **Kind**: query
- **Input**: `()`
- **Output**: `[SubscriptionMeta]`
- **Reachable via**: self-call (preapproved), agent tool `subz_list`
- Returns every tracked subscription with a live-computed `seconds_left`
  (clamped to ≥ 0). No pagination — bounded naturally by the 64-subscription
  cap.

#### `purge_log`
- **Kind**: query
- **Input**: `()`
- **Output**: `[PurgeEventView]`
- **Reachable via**: self-call (preapproved)
- Returns the burn/cancel history, most-recent-affecting operations kept up
  to the last 64 entries (older entries are dropped, not archived).

#### `get_key`
- **Kind**: query
- **Input**: `id : Text`
- **Output**: `?Blob`
- **Reachable via**: self-call (preapproved)
- Returns the raw AES-GCM ciphertext blob for a subscription's stored note,
  or `null` if there is none. **This is ciphertext, not a usable API key** —
  the browser must hold the vetKey-derived symmetric key to decrypt it (see
  `src/vetkeys.ts`); the canister has no way to read it either.

### Split sessions & seats

#### `create_session`
- **Kind**: update
- **Input**: `sub_id : Text`, `members : [Text]`
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- **Validation**: `sub_id` must reference an existing subscription; 1–8
  member names, each 1–64 bytes.
- Opens a new split-cost session for a subscription, seating every given
  member immediately (fails atomically if any member name is invalid or
  duplicated within the request).

#### `list_sessions`
- **Kind**: query
- **Input**: `()`
- **Output**: `[SessionView]`
- **Reachable via**: self-call (preapproved)
- Lists every split session (open and closed), each with its current seat
  list and payment status.

#### `mark_seat_paid`
- **Kind**: update
- **Input**: `session_id : Text`, `member : Text`, `paid : Bool`
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Toggles whether a named seat has paid their share. Purely a tracking
  flag — no ICP moves as a side effect of this call.

#### `close_session`
- **Kind**: update
- **Input**: `session_id : Text`
- **Output**: `Text` — `"Session closed"` or an error string
- **Reachable via**: self-call (preapproved)
- Marks a session closed to new joins via `split_join`. Existing seats and
  their paid state are left untouched.

#### `split_join`
- **Kind**: update
- **Input**: [`SplitJoinInput`](#types) *(plus a kernel-injected `caller :
  Principal` — see [Conventions](#kernel-injected-arguments-are-not-part-of-the-candid-input-tuple))*
- **Output**: `Text` — `"{member} joined {session_id}"` or an error string
- **Reachable via**: **public ingress only** — route `subz_split_v1/join`
  (`mode: update`, `caller: canister`, ≤ 256 bytes request/response,
  ≤ 60 calls/hour, requires 1,000,000,000 cycles per call). Not in
  `preapproved_self_calls` — subZ's own frontend does not call this itself.
- This is how a **friend's Neutron canister** claims a seat in a session on
  the user's behalf (e.g. after a person accepts a split invite in their own
  app). Fails if the session is closed, is already full (8 seats), the
  member name is invalid, or that member already holds a seat. As noted in
  [Conventions](#no-caller-side-auth-in-the-canister--permissions-live-in-neutronjson),
  the injected `caller` principal is accepted but not currently used for
  authorization — the ingress route's own rate/byte/cycle limits are the
  real guardrail.

### Pots & payments

> **Known limitation:** with the Wallet app installed, `vault_balance` and
> `pay_now` cannot currently reach the ICP ledger. See
> [Known limitations](../README.md#known-limitations) in the README for why —
> in short, Wallet reserves the entire ledger principal, which shadows
> subZ's narrower `exact`-scoped reservations. This is a platform-level
> conflict, not a bug in the methods documented here, and the payment-pot
> feature should be treated as **not yet functional** in that configuration.

#### `set_payee`
- **Kind**: update
- **Input**: `id : Text`, `payee : Text` (≤ 128 bytes)
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Sets the ICP principal (as text) that a subscription's pot pays out to.
  `payee` is stored as-is and only parsed with `Principal.fromText` at
  `pay_now` time — an invalid principal string is accepted here and only
  rejected when you actually try to pay.

#### `fund_pot`
- **Kind**: update
- **Input**: `id : Text`, `amount_e8s : Nat`
- **Output**: `Text` status message
- **Reachable via**: self-call (preapproved)
- Adds `amount_e8s` to a subscription's tracked pot balance and marks it
  `funded`. **This does not move any real ICP** — it's a ledger-agnostic
  counter on the subZ side; actually depositing ICP into the canister's own
  account is a separate, out-of-band step the UI doesn't automate.

#### `vault_balance`
- **Kind**: update, `async*`
- **Input**: `()`
- **Output**: [`BalanceView`](#types)
- **Reachable via**: self-call (preapproved)
- **Capability**: `backend_calls`, `exact` reservation on
  `icrc1_balance_of` against the ICP ledger (`ryjl3-tyaaa-aaaaa-aaaba-cai`)
- Calls the ICP ledger's `icrc1_balance_of` for the canister's own account.
  Returns `ok: false` with an explanatory `message` if the reservation isn't
  installed or the ledger call fails/decodes oddly — never traps.

#### `pay_now`
- **Kind**: update, `async*`
- **Input**: `id : Text`
- **Output**: [`PayResult`](#types)
- **Reachable via**: **interactive consent only**, via `callSelfDialog` (not
  `updateSelf`) — **not** in `preapproved_self_calls`. Every call surfaces a
  fresh confirmation to the user, unlike the silently-preapproved methods
  above, because it can move real ICP.
- **Capability**: `backend_calls`, `exact` reservation on `icrc1_transfer`
  against the ICP ledger
- **Validation**: pot must be non-zero, a payee must be set and parse as a
  valid principal, and the pot must exceed the 10,000 e8s (0.0001 ICP)
  ledger fee.
- Transfers `pot_e8s - fee` to the payee via `icrc1_transfer`. On a
  successful transfer it **clears the pot to zero and resets the fuse**
  (calls the same expiry-extension logic as `extend_subscription`) — paying
  counts as keeping the subscription. On any failure the pot balance is left
  untouched and `ok: false` is returned with a message.

### Internal

#### `expiry_monitor`
- **Kind**: internal, `async*`
- **Input**: `(())` *(plus a kernel-injected `task_capabilities :
  TaskCapabilities` — see [Conventions](#kernel-injected-arguments-are-not-part-of-the-candid-input-tuple))*
- **Output**: `()`
- **Reachable via**: `scheduled_tasks` only — runs hourly
  (`interval_seconds: 3600`, `run_on_start: true`, `max_backend_calls: 1`).
  Not callable by any frontend, agent, or external canister.
- Increments `monitor_runs` and sweeps every subscription whose
  `expires_at` has passed, deleting it and logging
  `"burned — never confirmed"` if `auto_delete` is on. This is the actual
  "silence deletes" mechanism behind the fuse pitch — everything else in
  this document is either setting up for this sweep or reacting to it.

## Permission surface reference

For completeness, the raw `neutron.json` declarations this document is
derived from:

- **`preapproved_self_calls.methods`**: `status`, `add_subscription`,
  `extend_subscription`, `delete_subscription`, `list_subscriptions`,
  `purge_log`, `get_key`, `set_policy`, `set_budget`, `set_funded`,
  `update_subscription`, `set_payee`, `fund_pot`, `vault_balance`,
  `create_session`, `list_sessions`, `mark_seat_paid`, `close_session`,
  `purge_now`, `sign_purge_receipt`. (Notably **not** `pay_now` — see
  above.)
- **`public_ingress.routes`**: one route, `subz_split_v1/join` →
  `split_join`.
- **`agent_entrypoints.entrypoints`**: `subz_list`, `subz_keep`,
  `subz_track` — implemented in `src/background.ts`.
- **`capabilities.backend_calls`**: `reservation_scopes: ["exact"]`,
  installed for `icrc1_balance_of` and `icrc1_transfer` on
  `ryjl3-tyaaa-aaaaa-aaaba-cai` (the ICP ledger), `max_concurrency: 2`.
- **`capabilities.chain_key_signing`**: one slot, `purge_receipts`
  (`ecdsa_secp256k1`, ≤ 4096-byte assertions).
- **`capabilities.vetkeys`**: one slot, `keys` — browser-side only, never
  reaches this API surface directly (see `src/vetkeys.ts`).

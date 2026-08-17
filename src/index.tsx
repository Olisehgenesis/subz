import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import {
  callSelfDialog,
  loadTileContext,
  querySelf,
  updateSelf,
} from "neutron-tools/app";
import type { VetKey } from "@dfinity/vetkeys";
import { deriveVaultKey, sealSecret, unsealSecret } from "./vetkeys";
import { SERVICE_TEMPLATES, CATEGORIES, monthlyAmount, parseAmount } from "./templates";
import "./style.scss";

type Status = {
  subscription_count: string;
  auto_delete: boolean;
  monitor_runs: string;
  purge_count: string;
  next_expiry_in: string | null;
  monthly_budget: string;
};

// The kernel's self-call codec carries Candid nat/int as decimal strings.
type RawSubscriptionMeta = {
  id: string;
  name: string;
  cost: string;
  category: string;
  funded: boolean;
  cancel_url: string;
  has_note: boolean;
  note_bytes: string;
  renew_days: string;
  pot_e8s: string;
  payee: string;
  created_at: string;
  expires_at: string;
  seconds_left: string;
};

type SubscriptionMeta = Omit<RawSubscriptionMeta,
  "note_bytes" | "renew_days" | "pot_e8s" | "created_at" | "expires_at" | "seconds_left"
> & {
  note_bytes: number;
  renew_days: number;
  pot_e8s: number;
  created_at: number;
  expires_at: number;
  seconds_left: number;
};

function normalizeSub(raw: RawSubscriptionMeta): SubscriptionMeta {
  return {
    ...raw,
    note_bytes: Number(raw.note_bytes),
    renew_days: Number(raw.renew_days),
    pot_e8s: Number(raw.pot_e8s),
    created_at: Number(raw.created_at),
    expires_at: Number(raw.expires_at),
    seconds_left: Number(raw.seconds_left),
  };
}

type PurgeEvent = {
  id: string;
  name: string;
  purged_at: string;
  reason: string;
};

type SessionView = {
  id: string;
  sub_id: string;
  sub_name: string;
  seats: Array<{ member: string; paid: boolean }>;
  open: boolean;
  created_at: string;
};

type Notice = { kind: "error" | "success"; text: string };

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00:00";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const hms = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

function secondsLeft(sub: SubscriptionMeta, nowMs: number): number {
  return Math.max(0, Math.round(sub.expires_at / 1e9 - nowMs / 1000));
}

function fuseFraction(sub: SubscriptionMeta, nowMs: number): number {
  const total = sub.renew_days * 86400;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, secondsLeft(sub, nowMs) / total));
}

function urgency(seconds: number): "danger" | "warning" | "ok" {
  if (seconds <= 0) return "danger";
  if (seconds < 86_400) return "warning";
  return "ok";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function formatIcp(e8s: number): string {
  return (e8s / 1e8).toFixed(4).replace(/\.?0+$/, "") + " ICP";
}

const CYCLE_PRESETS = [
  { label: "weekly", days: 7 },
  { label: "monthly", days: 30 },
  { label: "quarterly", days: 90 },
  { label: "yearly", days: 365 },
] as const;

const NoteIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const CancelIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 2c1 4-3 5-3 9a5 5 0 0 0 10 0c0-2-1-3.5-2-4.5C16.5 8 15 9 15 10c0-3-1-6-3-8Z" />
    <path d="M12 22a7 7 0 0 1-7-7" />
  </svg>
);

const PlusIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const App = () => {
  const [tileContext] = useState(() => loadTileContext());
  const [status, setStatus] = useState<Status | null>(null);
  const [subs, setSubs] = useState<SubscriptionMeta[]>([]);
  const [purges, setPurges] = useState<PurgeEvent[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [vetKey, setVetKey] = useState<VetKey | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showForm, setShowForm] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  const [showOps, setShowOps] = useState(false);
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [category, setCategory] = useState("custom");
  const [funded, setFunded] = useState(false);
  const [cancelUrl, setCancelUrl] = useState("");
  const [note, setNote] = useState("");
  const [renewDays, setRenewDays] = useState("30");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [splitMembers, setSplitMembers] = useState("");
  const [editFor, setEditFor] = useState<string | null>(null);
  const [potDrafts, setPotDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const loading = status === null;

  const refresh = useCallback(async () => {
    const [nextStatus, nextSubs, nextPurges, nextSessions] = await Promise.all([
      querySelf<Status>("status"),
      querySelf<RawSubscriptionMeta[]>("list_subscriptions"),
      querySelf<PurgeEvent[]>("purge_log"),
      querySelf<SessionView[]>("list_sessions"),
    ]);
    setStatus(nextStatus);
    setSubs(nextSubs.map(normalizeSub));
    setPurges(nextPurges);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setNotice({ kind: "error", text: formatError(error) });
    });
    const syncTimer = setInterval(() => {
      refresh().catch(() => undefined);
    }, 30_000);
    const tickTimer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      clearInterval(syncTimer);
      clearInterval(tickTimer);
      Object.values(flashTimers.current).forEach(clearTimeout);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!showForm && splitFor === null && editFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowForm(false);
        setSplitFor(null);
        setEditFor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showForm, splitFor, editFor]);

  const say = useCallback((next: Notice) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(() => setNotice(null), 4_000);
  }, []);

  const pulseRow = useCallback((id: string) => {
    setFlash((prev) => ({ ...prev, [id]: true }));
    flashTimers.current[id] = setTimeout(() => {
      setFlash((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete flashTimers.current[id];
    }, 700);
  }, []);

  const run = useCallback(
    async (action: () => Promise<string>, flashId?: string) => {
      setBusy(true);
      try {
        const message = await action();
        await refresh();
        if (flashId) pulseRow(flashId);
        say({ kind: "success", text: message });
      } catch (error: unknown) {
        say({ kind: "error", text: formatError(error) });
      } finally {
        setBusy(false);
      }
    },
    [refresh, pulseRow, say],
  );

  const applyTemplate = (templateName: string) => {
    if (templateName === selectedTemplate) {
      setSelectedTemplate(null);
      return;
    }
    const t = SERVICE_TEMPLATES.find((tpl) => tpl.name === templateName);
    if (!t) return;
    setSelectedTemplate(t.name);
    setName(t.name);
    setCost(t.cost);
    setCategory(t.category);
    setCancelUrl(t.cancelUrl);
    setRenewDays(String(t.renewDays));
  };

  const unlockKey = () => run(async () => {
    const key = await deriveVaultKey();
    setVetKey(key);
    return "Vault key derived — it never leaves this browser";
  });

  const addSubscription = () => run(async () => {
    const id = slugify(name);
    if (!id) throw new Error("Name must contain a letter or digit");
    const days = Number(renewDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("Renewal must be 1-3650 days");
    }
    let sealed: Uint8Array | null = null;
    if (note.trim()) {
      if (!vetKey) throw new Error("Derive the vault key before storing a sealed note");
      sealed = await sealSecret(vetKey, note.trim());
    }
    const message = await updateSelf<string>("add_subscription", [
      {
        id,
        name: name.trim(),
        cost: cost.trim(),
        category,
        funded,
        cancel_url: cancelUrl.trim(),
        note_ciphertext: sealed,
        renew_days: String(days),
      },
    ]);
    setName("");
    setCost("");
    setCategory("custom");
    setFunded(false);
    setCancelUrl("");
    setNote("");
    setSelectedTemplate(null);
    setShowForm(false);
    return message;
  });

  const keep = (id: string) => run(async () => {
    return await updateSelf<string>("extend_subscription", [id]);
  }, id);

  const cancel = (id: string) => run(async () => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    return await updateSelf<string>("delete_subscription", [id]);
  });

  const toggleNote = (id: string, hasNote: boolean) => run(async () => {
    if (revealed[id] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return "Note hidden";
    }
    if (!hasNote) return "No sealed note";
    if (!vetKey) throw new Error("Derive the vault key first");
    const blob = await querySelf<Uint8Array | null>("get_key", [id]);
    if (!blob) return "No sealed note for " + id;
    const bytes =
      blob instanceof Uint8Array ? blob : Uint8Array.from(blob as unknown as number[]);
    const text = await unsealSecret(vetKey, bytes);
    setRevealed((prev) => ({ ...prev, [id]: text }));
    return "Note unsealed";
  });

  const togglePolicy = () => run(async () => {
    if (!status) return "Status not loaded";
    return await updateSelf<string>("set_policy", [!status.auto_delete]);
  });

  const saveBudget = () => run(async () => {
    return await updateSelf<string>("set_budget", [budgetDraft.trim()]);
  });

  const toggleFunded = (id: string, current: boolean) => run(async () => {
    return await updateSelf<string>("set_funded", [id, !current]);
  });

  const createSession = () => run(async () => {
    if (!splitFor) return "Nothing selected";
    const members = splitMembers
      .split(/[\n,]+/)
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    const message = await updateSelf<string>("create_session", [splitFor, members]);
    setSplitFor(null);
    setSplitMembers("");
    return message;
  });

  const toggleSeatPaid = (sessionId: string, member: string, paid: boolean) => run(async () => {
    return await updateSelf<string>("mark_seat_paid", [sessionId, member, !paid]);
  });

  const closeSession = (sessionId: string) => run(async () => {
    return await updateSelf<string>("close_session", [sessionId]);
  });

  const openEdit = (s: SubscriptionMeta) => {
    setEditFor(s.id);
    setName(s.name);
    setCost(s.cost);
    setCategory(s.category || "custom");
    setCancelUrl(s.cancel_url);
    setRenewDays(String(s.renew_days));
  };

  const saveEdit = () => run(async () => {
    if (!editFor) return "Nothing selected";
    const days = Number(renewDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("Renewal must be 1-3650 days");
    }
    const message = await updateSelf<string>("update_subscription", [
      {
        id: editFor,
        name: name.trim(),
        cost: cost.trim(),
        category,
        cancel_url: cancelUrl.trim(),
        renew_days: String(days),
      },
    ]);
    setEditFor(null);
    setName("");
    setCost("");
    setCategory("custom");
    setCancelUrl("");
    setRenewDays("30");
    return message;
  });

  const fundPot = (id: string) => run(async () => {
    const draft = Number(potDrafts[id] ?? "");
    if (!Number.isFinite(draft) || draft <= 0) throw new Error("Enter an ICP amount first");
    const e8s = Math.round(draft * 1e8);
    const message = await updateSelf<string>("fund_pot", [id, String(e8s)]);
    setPotDrafts((prev) => ({ ...prev, [id]: "" }));
    return message;
  });

  const payNow = (id: string) => run(async () => {
    // Spending moves real ICP: this goes through the kernel consent dialog.
    const result = await callSelfDialog<{ ok: boolean; message: string }>("pay_now", [id]);
    if (!result.ok) throw new Error(result.message);
    return result.message;
  });

  const purgeNow = () => run(async () => {
    return await updateSelf<string>("purge_now");
  });

  const signReceipt = () => run(async () => {
    const receipt = await updateSelf<{ ok: boolean; error: string; signature_hex: string }>(
      "sign_purge_receipt",
    );
    return receipt.ok
      ? "Burn receipt signed: " + receipt.signature_hex.slice(0, 34) + "…"
      : "Receipt failed: " + receipt.error;
  });

  const nextSub = subs.length
    ? subs.reduce((a, b) => (secondsLeft(a, nowMs) <= secondsLeft(b, nowMs) ? a : b))
    : null;
  const heroSeconds = nextSub ? secondsLeft(nextSub, nowMs) : null;
  const heroUrgency = heroSeconds === null ? "ok" : urgency(heroSeconds);

  const visibleSubs = categoryFilter
    ? subs.filter((s) => s.category === categoryFilter)
    : subs;
  const presentCategories = [...new Set(subs.map((s) => s.category))];
  const monthlyBurn = subs.reduce((sum, s) => sum + (monthlyAmount(s.cost, s.renew_days) ?? 0), 0);
  const budgetAmount = status ? parseAmount(status.monthly_budget) : null;

  return (
    <main className={cx(nt.appFill, "subz-app")}>
      <div className="nt-page subz-shell">
        <header className="subz-topbar">
          <div className="subz-brand">
            <p className="subz-eyebrow">Keep it or it burns</p>
            <h1 className="subz-wordmark">sub<span className="subz-wordmark-z">Z</span></h1>
          </div>
          <div className="subz-topbar-actions">
            <span
              className={cx("nt-tag", {
                "nt-tag--success": status?.auto_delete,
                "nt-tag--warning": status !== null && !status.auto_delete,
              })}
              title={status ? `${status.monitor_runs} sweeps · ${status.purge_count} burned` : ""}
            >
              {status ? (status.auto_delete ? "auto-burn" : "paused") : "…"}
            </span>
            <button
              className="nt-button nt-button--sm"
              type="button"
              onClick={() => setShowForm(true)}
              data-tid="subz-open-add"
            >
              {PlusIcon} Track a sub
            </button>
          </div>
        </header>

        <main className="nt-page-main">
          <section
            className={cx("subz-hero", {
              "subz-hero--warning": heroUrgency === "warning",
              "subz-hero--danger": heroUrgency === "danger",
            })}
            aria-label="Next renewal"
          >
            <div className="subz-hero-row">
              <span className="subz-hero-label">
                {loading
                  ? "Reading your subs…"
                  : nextSub
                    ? `${nextSub.name}${nextSub.cost ? ` · ${nextSub.cost}` : ""} renews in`
                    : "No subs tracked"}
              </span>
              <strong className="subz-hero-value" data-tid="subz-countdown">
                {heroSeconds !== null ? formatCountdown(heroSeconds) : loading ? "··:··:··" : "—"}
              </strong>
            </div>
            {nextSub ? (
              <div className={cx("subz-fuse", `subz-fuse--${heroUrgency}`)} aria-hidden="true">
                <span
                  className="subz-fuse-fill"
                  style={{ width: `${fuseFraction(nextSub, nowMs) * 100}%` }}
                />
              </div>
            ) : null}
            <span className="nt-metric-detail">
              {nextSub ? "keep it, or let it burn as your cue to cancel" : "track one and set its renewal"}
            </span>
            {subs.length > 0 && monthlyBurn > 0 ? (
              <div className="subz-budget" aria-label="Monthly burn">
                <span className="subz-budget-figures">
                  ${monthlyBurn.toFixed(0)}
                  {budgetAmount !== null ? ` of $${budgetAmount.toFixed(0)}` : ""}
                  <span className="subz-budget-unit"> /mo burn</span>
                </span>
                <div
                  className={cx("subz-fuse", "subz-budget-meter", {
                    "subz-fuse--danger": budgetAmount !== null && monthlyBurn > budgetAmount,
                  })}
                  aria-hidden="true"
                >
                  <span
                    className="subz-fuse-fill"
                    style={{
                      width: `${budgetAmount ? Math.min(100, (monthlyBurn / budgetAmount) * 100) : 100}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}
          </section>

          {vetKey === null && !loading ? (
            <div className="nt-callout nt-callout--warning subz-unlock-callout">
              <div className="subz-unlock-copy">
                <strong>Vault key locked.</strong>
                <span className="nt-text">Derive it in this browser to seal or read account notes.</span>
              </div>
              <button className="nt-button nt-button--sm" disabled={busy} onClick={unlockKey} type="button">
                Derive vault key
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="subz-grid" aria-hidden="true">
              <div className="subz-card subz-skel" />
              <div className="subz-card subz-skel" />
              <div className="subz-card subz-skel" />
            </div>
          ) : subs.length === 0 ? (
            <section className="subz-empty">
              <p className="subz-empty-title">Nothing on your card yet.</p>
              <p className="nt-text">
                Track a subscription and its renewal date. Confirm you still want it
                before the fuse runs out — or it burns, and that's your cue to cancel.
              </p>
              <button className="nt-button" type="button" onClick={() => setShowForm(true)}>
                {PlusIcon} Track your first sub
              </button>
            </section>
          ) : (
            <section aria-label="Tracked subscriptions">
              {presentCategories.length > 1 ? (
                <div className="subz-filters" role="tablist" aria-label="Filter by category">
                  <button
                    className={cx("subz-filter", { "subz-filter--active": categoryFilter === null })}
                    type="button"
                    onClick={() => setCategoryFilter(null)}
                  >
                    All
                  </button>
                  {presentCategories.map((c) => (
                    <button
                      key={c}
                      className={cx("subz-filter", { "subz-filter--active": categoryFilter === c })}
                      type="button"
                      onClick={() => setCategoryFilter(categoryFilter === c ? null : c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="subz-grid">
                {visibleSubs.map((s) => {
                  const left = secondsLeft(s, nowMs);
                  const state = urgency(left);
                  return (
                    <article
                      key={s.id}
                      className={cx("subz-card", `subz-card--${state}`, {
                        "subz-card--flash": flash[s.id],
                      })}
                    >
                      <div className="subz-card-head">
                        <strong className="subz-card-name" title={s.name}>{s.name}</strong>
                        <span className="subz-card-meta">{s.cost || "—"}</span>
                      </div>
                      <strong className="subz-card-count">{formatCountdown(left)}</strong>
                      <p className="subz-card-sub">
                        {s.category || "custom"} · every {s.renew_days}d
                        {s.has_note ? " · note sealed" : ""}
                      </p>
                      {revealed[s.id] !== undefined ? (
                        <pre className="subz-revealed">{revealed[s.id]}</pre>
                      ) : null}
                      <div className="subz-card-actions">
                        <button
                          className="nt-button nt-button--sm"
                          disabled={busy}
                          onClick={() => keep(s.id)}
                          type="button"
                        >
                          Keep it
                        </button>
                        <button
                          className="nt-button nt-button--ghost nt-button--sm"
                          disabled={busy}
                          onClick={() => setSplitFor(s.id)}
                          type="button"
                        >
                          Split
                        </button>
                        <button
                          className="nt-button nt-button--ghost nt-button--sm"
                          disabled={busy}
                          onClick={() => openEdit(s)}
                          type="button"
                        >
                          Edit
                        </button>
                        {s.has_note ? (
                          <button
                            className="nt-icon-button"
                            disabled={busy || !vetKey}
                            onClick={() => toggleNote(s.id, s.has_note)}
                            type="button"
                            title={revealed[s.id] !== undefined ? "Hide note" : "Read sealed note"}
                          >
                            {NoteIcon}
                          </button>
                        ) : null}
                        <button
                          className={cx("nt-tag", "subz-funded", { "nt-tag--success": s.funded })}
                          disabled={busy}
                          onClick={() => toggleFunded(s.id, s.funded)}
                          type="button"
                          title={s.funded ? "Money set aside — click to unfund" : "Mark money set aside"}
                        >
                          {s.funded ? "funded" : "unfunded"}
                        </button>
                        {s.cancel_url ? (
                          <a
                            className="nt-icon-button subz-cancel-link"
                            href={s.cancel_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Open cancel page"
                          >
                            ↗
                          </a>
                        ) : null}
                        <button
                          className="nt-icon-button subz-delete"
                          disabled={busy}
                          onClick={() => cancel(s.id)}
                          type="button"
                          title="Mark cancelled"
                        >
                          {CancelIcon}
                        </button>
                      </div>
                      <div className={cx("subz-fuse", `subz-fuse--${state}`)} aria-hidden="true">
                        <span
                          className="subz-fuse-fill"
                          style={{ width: `${fuseFraction(s, nowMs) * 100}%` }}
                        />
                      </div>
                      <div className="subz-pot">
                        <span className="subz-pot-label">
                          pot: {s.pot_e8s > 0 ? formatIcp(s.pot_e8s) : "empty"}
                          {s.payee ? "" : " · no payee"}
                        </span>
                        <input
                          className="nt-input subz-pot-input"
                          inputMode="decimal"
                          placeholder="0.5"
                          aria-label={`Fund ${s.name} pot in ICP`}
                          value={potDrafts[s.id] ?? ""}
                          onChange={(e) =>
                            setPotDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                          }
                        />
                        <button
                          className="nt-button nt-button--ghost nt-button--sm"
                          disabled={busy || !(potDrafts[s.id] ?? "").trim()}
                          onClick={() => fundPot(s.id)}
                          type="button"
                        >
                          Fund
                        </button>
                        <button
                          className="nt-button nt-button--sm"
                          disabled={busy || s.pot_e8s === 0}
                          onClick={() => payNow(s.id)}
                          type="button"
                          title="Pays the pot to the payee and resets the fuse"
                        >
                          Pay
                        </button>
                      </div>
                      {sessions.filter((sess) => sess.sub_id === s.id).map((sess) => {
                        const share = parseAmount(s.cost);
                        const perSeat = share !== null ? share / (sess.seats.length + 1) : null;
                        return (
                          <div key={sess.id} className="subz-session">
                            <div className="subz-session-head">
                              <span className="subz-session-title">
                                split · {sess.seats.length} seat{sess.seats.length === 1 ? "" : "s"}
                                {perSeat !== null ? ` · $${perSeat.toFixed(2)} each` : ""}
                              </span>
                              {sess.open ? (
                                <button
                                  className="nt-button nt-button--ghost nt-button--sm"
                                  disabled={busy}
                                  onClick={() => closeSession(sess.id)}
                                  type="button"
                                >
                                  Close
                                </button>
                              ) : (
                                <span className="nt-tag">closed</span>
                              )}
                            </div>
                            <ul className="subz-seat-list">
                              {sess.seats.map((seat) => (
                                <li key={seat.member} className="subz-seat">
                                  <span className={cx("subz-seat-name", { "subz-seat-name--paid": seat.paid })}>
                                    {seat.member}
                                  </span>
                                  <button
                                    className={cx("nt-tag", "subz-funded", { "nt-tag--success": seat.paid })}
                                    disabled={busy || !sess.open}
                                    onClick={() => toggleSeatPaid(sess.id, seat.member, seat.paid)}
                                    type="button"
                                  >
                                    {seat.paid ? "paid" : "owes"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                            {sess.open ? (
                              <p className="nt-meta subz-session-join">
                                Friends running subZ can claim a seat — route subz_split_v1/join on this canister, id {sess.id}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <section className="subz-fold" aria-label="Operations">
            <button
              className="subz-fold-trigger"
              type="button"
              onClick={() => setShowOps((v) => !v)}
              aria-expanded={showOps}
            >
              <span className={cx("subz-chevron", { "subz-chevron--open": showOps })}>▸</span>
              Operations
            </button>
            {showOps ? (
              <div className="subz-fold-body">
                <div className="nt-field">
                  <label className="nt-label" htmlFor="subz-budget">Monthly budget <span className="nt-muted">(USD)</span></label>
                  <div className="subz-budget-edit">
                    <input
                      id="subz-budget"
                      className="nt-input"
                      inputMode="decimal"
                      placeholder={status?.monthly_budget || "400"}
                      value={budgetDraft}
                      onChange={(e) => setBudgetDraft(e.target.value)}
                    />
                    <button className="nt-button nt-button--sm" disabled={busy} onClick={saveBudget} type="button">
                      Save
                    </button>
                  </div>
                </div>
                <div className="subz-actions">
                  <button className="nt-button nt-button--ghost nt-button--sm" disabled={busy || !status} onClick={togglePolicy} type="button">
                    {status?.auto_delete ? "Pause auto-burn" : "Resume auto-burn"}
                  </button>
                  <button className="nt-button nt-button--ghost nt-button--sm" disabled={busy} onClick={purgeNow} type="button">
                    Burn expired now
                  </button>
                  <button className="nt-button nt-button--ghost nt-button--sm" disabled={busy} onClick={signReceipt} type="button">
                    Sign burn receipt
                  </button>
                </div>
                <p className="nt-meta subz-ops-note">
                  The expiry sweep runs on-chain every hour. A signed burn receipt is
                  threshold-signed by the subnet — proof of what you let go.
                </p>
              </div>
            ) : null}
          </section>

          {purges.length > 0 ? (
            <section className="subz-fold" aria-label="Burn record">
              <button
                className="subz-fold-trigger"
                type="button"
                onClick={() => setShowRecord((v) => !v)}
                aria-expanded={showRecord}
              >
                <span className={cx("subz-chevron", { "subz-chevron--open": showRecord })}>▸</span>
                Burn record
                <span className="nt-badge nt-badge--danger">{purges.length}</span>
              </button>
              {showRecord ? (
                <ul className="subz-fold-body subz-burn-list">
                  {purges.map((p, i) => (
                    <li key={`${p.id}-${i}`} className="subz-purge">
                      <span className="subz-purge-name">{p.name}</span>
                      <span className="nt-meta subz-purge-date">
                        {new Date(Number(p.purged_at) / 1_000_000).toLocaleString()} · {p.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </main>

        <footer className="nt-page-footer subz-footer">
          <span className="nt-meta">tile {tileContext.tile ?? "main"}</span>
        </footer>
      </div>

      {showForm ? (
        <div
          className="subz-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <div className="subz-dialog" role="dialog" aria-label="Track a subscription">
            <div className="subz-dialog-head">
              <h2 className="nt-subtitle">Track a subscription</h2>
              <button className="nt-icon-button" type="button" onClick={() => setShowForm(false)} title="Close">
                ✕
              </button>
            </div>
            <div className="subz-templates" role="listbox" aria-label="Common subscriptions">
              {SERVICE_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  className={cx("subz-template", {
                    "subz-template--selected": selectedTemplate === t.name,
                  })}
                  type="button"
                  role="option"
                  aria-selected={selectedTemplate === t.name}
                  onClick={() => applyTemplate(t.name)}
                >
                  <span
                    className="subz-template-tile"
                    style={{ "--tile-color": t.color } as React.CSSProperties}
                  >
                    {t.name.slice(0, 1)}
                  </span>
                  <span className="subz-template-name">{t.name}</span>
                </button>
              ))}
            </div>
            <div className="nt-form-grid nt-form-grid--two">
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-name">Name</label>
                <input
                  id="subz-name"
                  className="nt-input"
                  placeholder="Netflix"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-cost">Cost <span className="nt-muted">(optional)</span></label>
                <input
                  id="subz-cost"
                  className="nt-input"
                  placeholder="$15.49/mo"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
            </div>
            <div className="nt-field">
              <span className="nt-label" id="subz-category-label">Category</span>
              <div className="subz-filters" role="group" aria-labelledby="subz-category-label">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className={cx("subz-filter", { "subz-filter--active": category === c })}
                    type="button"
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="nt-form-grid nt-form-grid--two">
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-days">Renews every (days)</label>
                <input
                  id="subz-days"
                  className="nt-input"
                  inputMode="numeric"
                  value={renewDays}
                  onChange={(e) => setRenewDays(e.target.value)}
                />
                <div className="subz-presets">
                  {CYCLE_PRESETS.map((p) => (
                    <button
                      key={p.days}
                      className={cx("subz-filter", { "subz-filter--active": renewDays === String(p.days) })}
                      type="button"
                      onClick={() => setRenewDays(String(p.days))}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-cancel">Cancel link <span className="nt-muted">(optional)</span></label>
                <input
                  id="subz-cancel"
                  className="nt-input"
                  placeholder="https://…/cancel"
                  value={cancelUrl}
                  onChange={(e) => setCancelUrl(e.target.value)}
                />
              </div>
            </div>
            <div className="nt-field">
              <label className="nt-label" htmlFor="subz-note">Account note <span className="nt-muted">(sealed in this browser, optional)</span></label>
              <textarea
                id="subz-note"
                className="nt-input"
                placeholder="login email, card last four, family plan members…"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="nt-help">
                Encrypted with your vetKey before upload. The canister only stores ciphertext.
              </p>
            </div>
            <div className="subz-dialog-actions">
              <label className="subz-funded-check">
                <input
                  type="checkbox"
                  className="nt-checkbox"
                  checked={funded}
                  onChange={(e) => setFunded(e.target.checked)}
                />
                Money already set aside
              </label>
              <button className="nt-button nt-button--ghost" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button
                className="nt-button"
                disabled={busy || !name.trim()}
                onClick={addSubscription}
                type="button"
                data-tid="subz-add"
              >
                Track it
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {splitFor !== null ? (
        <div
          className="subz-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSplitFor(null);
          }}
        >
          <div className="subz-dialog" role="dialog" aria-label="Split this subscription">
            <div className="subz-dialog-head">
              <h2 className="nt-subtitle">
                Split {subs.find((s) => s.id === splitFor)?.name ?? ""}
              </h2>
              <button className="nt-icon-button" type="button" onClick={() => setSplitFor(null)} title="Close">
                ✕
              </button>
            </div>
            <div className="nt-field">
              <label className="nt-label" htmlFor="subz-members">Members <span className="nt-muted">(one per line)</span></label>
              <textarea
                id="subz-members"
                className="nt-input"
                placeholder={"alice\nbob\ncarol"}
                rows={3}
                autoFocus
                value={splitMembers}
                onChange={(e) => setSplitMembers(e.target.value)}
              />
              <p className="nt-help">
                Each seat owes an equal share. Friends on their own Neutrons can also
                claim a seat through the paid split route — their canister pays, yours
                never polls.
              </p>
            </div>
            <div className="subz-dialog-actions">
              <button className="nt-button nt-button--ghost" type="button" onClick={() => setSplitFor(null)}>
                Cancel
              </button>
              <button
                className="nt-button"
                disabled={busy || !splitMembers.trim()}
                onClick={createSession}
                type="button"
                data-tid="subz-create-session"
              >
                Start the split
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editFor !== null ? (
        <div
          className="subz-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditFor(null);
          }}
        >
          <div className="subz-dialog" role="dialog" aria-label="Edit subscription">
            <div className="subz-dialog-head">
              <h2 className="nt-subtitle">Edit {subs.find((s) => s.id === editFor)?.name ?? ""}</h2>
              <button className="nt-icon-button" type="button" onClick={() => setEditFor(null)} title="Close">
                ✕
              </button>
            </div>
            <div className="nt-form-grid nt-form-grid--two">
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-edit-name">Name</label>
                <input
                  id="subz-edit-name"
                  className="nt-input"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-edit-cost">Cost</label>
                <input
                  id="subz-edit-cost"
                  className="nt-input"
                  placeholder="$15.49/mo"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
            </div>
            <div className="nt-field">
              <span className="nt-label" id="subz-edit-category-label">Category</span>
              <div className="subz-filters" role="group" aria-labelledby="subz-edit-category-label">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className={cx("subz-filter", { "subz-filter--active": category === c })}
                    type="button"
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="nt-form-grid nt-form-grid--two">
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-edit-days">Renews every (days)</label>
                <input
                  id="subz-edit-days"
                  className="nt-input"
                  inputMode="numeric"
                  value={renewDays}
                  onChange={(e) => setRenewDays(e.target.value)}
                />
                <div className="subz-presets">
                  {CYCLE_PRESETS.map((p) => (
                    <button
                      key={p.days}
                      className={cx("subz-filter", { "subz-filter--active": renewDays === String(p.days) })}
                      type="button"
                      onClick={() => setRenewDays(String(p.days))}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="subz-edit-cancel">Cancel link</label>
                <input
                  id="subz-edit-cancel"
                  className="nt-input"
                  placeholder="https://…/cancel"
                  value={cancelUrl}
                  onChange={(e) => setCancelUrl(e.target.value)}
                />
              </div>
            </div>
            <p className="nt-help">Editing never resets the fuse — the burn clock stays as it was.</p>
            <div className="subz-dialog-actions">
              <button className="nt-button nt-button--ghost" type="button" onClick={() => setEditFor(null)}>
                Cancel
              </button>
              <button
                className="nt-button"
                disabled={busy || !name.trim()}
                onClick={saveEdit}
                type="button"
                data-tid="subz-save-edit"
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div
          className={cx("subz-toast", `subz-toast--${notice.kind}`)}
          role="status"
          data-tid="subz-notice"
        >
          {notice.text}
        </div>
      ) : null}
    </main>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(<App />);

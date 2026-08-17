import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { onAppStateChange, querySelf, updateSelf } from "neutron-tools/app";
import "./style.scss";

type SubscriptionMeta = {
  id: string;
  name: string;
  cost: string;
  seconds_left: string;
};

function formatShort(seconds: number): string {
  if (seconds <= 0) return "due";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

const Tray = () => {
  const [subs, setSubs] = useState<SubscriptionMeta[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const all = await querySelf<SubscriptionMeta[]>("list_subscriptions");
    setSubs(
      [...all].sort((a, b) => Number(a.seconds_left) - Number(b.seconds_left)).slice(0, 5),
    );
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
    return onAppStateChange("subz", () => {
      refresh().catch(() => undefined);
    });
  }, [refresh]);

  const keep = async (id: string) => {
    setBusyId(id);
    try {
      await updateSelf<string>("extend_subscription", [id]);
      await refresh();
    } catch {
      // The tile surfaces errors; the tray stays quiet.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className={cx(nt.appFill, "subz-app", "subz-tray")}>
      <p className="subz-tray-title">Burning soonest</p>
      {subs === null ? (
        <p className="nt-meta">…</p>
      ) : subs.length === 0 ? (
        <p className="nt-meta">Nothing tracked.</p>
      ) : (
        <ul className="subz-tray-list">
          {subs.map((s) => (
            <li key={s.id} className="subz-tray-row">
              <span className="subz-tray-name">{s.name}</span>
              <span className="subz-tray-meta">
                {s.cost ? `${s.cost} · ` : ""}
                {formatShort(Number(s.seconds_left))}
              </span>
              <button
                className="nt-button nt-button--sm"
                disabled={busyId !== null}
                onClick={() => keep(s.id)}
                type="button"
              >
                Keep
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
};

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<Tray />);

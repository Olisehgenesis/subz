import {
  exposeTool,
  publishAppStateChange,
  querySelf,
  setTrayState,
  updateSelf,
  type JsonObject,
} from "neutron-tools/app";

const STATE_TOPIC = "subz";
const DUE_SOON_SECONDS = 7 * 86_400;
let revision = 0;

type SubscriptionMeta = {
  id: string;
  name: string;
  cost: string;
  category: string;
  funded: boolean;
  renew_days: number;
  seconds_left: number;
};

const listSchema: JsonObject = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      cost: { type: "string" },
      category: { type: "string" },
      funded: { type: "boolean" },
      renewDays: { type: "number" },
      secondsLeft: { type: "number" },
    },
  },
};

async function fetchSubs(): Promise<SubscriptionMeta[]> {
  return querySelf<SubscriptionMeta[]>("list_subscriptions");
}

function dueSoon(subs: SubscriptionMeta[]): SubscriptionMeta[] {
  return subs.filter((s) => s.seconds_left <= DUE_SOON_SECONDS);
}

async function syncBadge(): Promise<void> {
  try {
    const subs = await fetchSubs();
    const due = dueSoon(subs).length;
    await setTrayState({ badge: due > 0 ? due : null });
    revision += 1;
    publishAppStateChange(STATE_TOPIC, revision);
  } catch {
    // The kernel drops badge updates from a dead endpoint; retry next tick.
  }
}

exposeTool(
  "subz_list",
  {
    title: "List subscriptions",
    description: "List tracked subscriptions with cost, category, funding state, and time until each burns.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: listSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async () => {
    const subs = await fetchSubs();
    return subs.map((s) => ({
      id: s.id,
      name: s.name,
      cost: s.cost,
      category: s.category,
      funded: s.funded,
      renewDays: s.renew_days,
      secondsLeft: s.seconds_left,
    }));
  },
);

exposeTool(
  "subz_keep",
  {
    title: "Keep a subscription",
    description: "Confirm a subscription is still wanted; resets its burn fuse for another cycle.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    annotations: { "neutron:effects": ["write"] },
  },
  async (args) => {
    const id = typeof args.id === "string" ? args.id : "";
    const message = await updateSelf<string>("extend_subscription", [id]);
    await syncBadge();
    return message;
  },
);

exposeTool(
  "subz_track",
  {
    title: "Track a subscription",
    description: "Track a new recurring payment with a name, optional cost, category, and renewal period in days.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        cost: { type: "string", maxLength: 32 },
        category: { type: "string", maxLength: 24 },
        renewDays: { type: "number", minimum: 1, maximum: 3650 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    annotations: { "neutron:effects": ["write"] },
  },
  async (args) => {
    const name = typeof args.name === "string" ? args.name : "";
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const message = await updateSelf<string>("add_subscription", [
      {
        id,
        name,
        cost: typeof args.cost === "string" ? args.cost : "",
        category: typeof args.category === "string" ? args.category : "custom",
        funded: false,
        cancel_url: "",
        note_ciphertext: null,
        renew_days: typeof args.renewDays === "number" ? args.renewDays : 30,
      },
    ]);
    await syncBadge();
    return message;
  },
);

await syncBadge();
setInterval(() => {
  void syncBadge();
}, 60_000);

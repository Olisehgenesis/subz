export type ServiceTemplate = {
  name: string;
  cost: string;
  category: string;
  cancelUrl: string;
  color: string;
  renewDays: number;
};

// Common recurring life payments, grouped by category. Selecting one prefills
// the form; everything stays editable for anything else.
export const CATEGORIES = [
  "streaming",
  "utilities",
  "software",
  "life",
  "custom",
] as const;

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  // utilities — the bills you can't ghost
  { name: "Rent", cost: "", category: "utilities", cancelUrl: "", color: "#c98a5e", renewDays: 30 },
  { name: "Electricity", cost: "", category: "utilities", cancelUrl: "", color: "#f2c14e", renewDays: 30 },
  { name: "Water", cost: "", category: "utilities", cancelUrl: "", color: "#4ea8f2", renewDays: 30 },
  { name: "Internet", cost: "", category: "utilities", cancelUrl: "", color: "#7dd3fc", renewDays: 30 },
  { name: "Phone", cost: "", category: "utilities", cancelUrl: "", color: "#86c5a5", renewDays: 30 },
  // streaming
  { name: "Netflix", cost: "$15.49/mo", category: "streaming", cancelUrl: "https://www.netflix.com/cancelplan", color: "#e50914", renewDays: 30 },
  { name: "Spotify", cost: "$11.99/mo", category: "streaming", cancelUrl: "https://www.spotify.com/account/subscription/cancel/", color: "#1db954", renewDays: 30 },
  { name: "YouTube Premium", cost: "$13.99/mo", category: "streaming", cancelUrl: "https://www.youtube.com/paid_memberships", color: "#ff4444", renewDays: 30 },
  { name: "Disney+", cost: "$13.99/mo", category: "streaming", cancelUrl: "https://www.disneyplus.com/account", color: "#3c63f2", renewDays: 30 },
  { name: "Game Pass", cost: "$11.99/mo", category: "streaming", cancelUrl: "https://account.microsoft.com/services", color: "#107c10", renewDays: 30 },
  // software & AI
  { name: "ChatGPT Plus", cost: "$20/mo", category: "software", cancelUrl: "https://chatgpt.com/#settings", color: "#10a37f", renewDays: 30 },
  { name: "Claude Pro", cost: "$20/mo", category: "software", cancelUrl: "https://claude.ai/settings", color: "#d97757", renewDays: 30 },
  { name: "iCloud+", cost: "$2.99/mo", category: "software", cancelUrl: "https://support.apple.com/HT207618", color: "#8e8e93", renewDays: 30 },
  { name: "Notion Plus", cost: "$10/mo", category: "software", cancelUrl: "https://www.notion.so/settings/billing", color: "#b3b3b3", renewDays: 30 },
  { name: "Figma", cost: "$15/mo", category: "software", cancelUrl: "https://www.figma.com/settings#billing", color: "#a259ff", renewDays: 30 },
  // life
  { name: "Gym", cost: "", category: "life", cancelUrl: "", color: "#e8a15c", renewDays: 30 },
  { name: "Insurance", cost: "", category: "life", cancelUrl: "", color: "#6b8afd", renewDays: 30 },
  { name: "Haircut", cost: "", category: "life", cancelUrl: "", color: "#d4879b", renewDays: 42 },
];

export function parseAmount(cost: string): number | null {
  const match = cost.replace(",", "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/** Normalizes a per-cycle cost to a rough monthly figure. */
export function monthlyAmount(cost: string, renewDays: number): number | null {
  const amount = parseAmount(cost);
  if (amount === null || renewDays <= 0) return null;
  return (amount * 30) / renewDays;
}

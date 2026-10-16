const BMAN_ORIGIN = "https://bman.buidl4.top";

// Public display metadata mirrored from bman's presets/agents.yaml.
// Soul and owner data intentionally remain in bman.
export const BMAN_HOME_AGENTS = [
  {
    id: "zec",
    routeSymbol: "ZEC",
    avatarUrl: "https://bman-assets.buidl4.top/agents/zec-fb1c2fbbc532ef08.webp",
  },
  {
    id: "near",
    routeSymbol: "NEAR",
    avatarUrl: "https://bman-assets.buidl4.top/agents/near-3312fe9bc5abca89.webp",
  },
  {
    id: "niulai",
    routeSymbol: "牛来",
    avatarUrl: "https://bman-assets.buidl4.top/agents/niulai-023a7c868534c9bc.webp",
  },
  {
    id: "tron",
    routeSymbol: "TRON",
    avatarUrl: "https://cryptologos.cc/logos/tron-trx-logo.png",
  },
] as const;

export function bmanAgentProfileHref(routeSymbol: string): string {
  return `${BMAN_ORIGIN}/agents/${encodeURIComponent(`$${routeSymbol}`)}`;
}

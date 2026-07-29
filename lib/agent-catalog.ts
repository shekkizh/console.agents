import type { AgentProfile } from "@/lib/types";

export const agentCatalog: AgentProfile[] = [
  { id: "atlas", name: "Atlas", initials: "AT", specialty: "Research & synthesis", description: "Finds signal across sources and turns it into decisive briefs.", status: "ready", color: "#c8f169" },
  { id: "forge", name: "Forge", initials: "FG", specialty: "Product engineering", description: "Builds, tests, and documents production-ready software.", status: "ready", color: "#8bb8ff" },
  { id: "muse", name: "Muse", initials: "MU", specialty: "Writing & strategy", description: "Shapes raw ideas into clear narratives and launch plans.", status: "ready", color: "#f0ae88" },
];

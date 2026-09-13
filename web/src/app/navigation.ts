import { BotIcon, MessageSquareIcon, SettingsIcon, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Whether the current path belongs to this item. */
  matches: (pathname: string) => boolean;
  hint: string;
}

/** The primary navigation, in the order an operator's day runs: what is happening, the threads, the agents, the machine. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/conversations", label: "Conversations", Icon: MessageSquareIcon, matches: (p) => p.startsWith("/conversations"), hint: "Your conversations with the Orchestrator" },
  { to: "/agents", label: "Agents", Icon: BotIcon, matches: (p) => p.startsWith("/agents"), hint: "The Agent Definitions Runs execute" },
  { to: "/settings/general", label: "Settings", Icon: SettingsIcon, matches: (p) => p.startsWith("/settings"), hint: "Providers, tools, preferences, workspaces, and system configuration" },
];

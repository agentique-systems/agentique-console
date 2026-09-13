import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import type { SettingsValues } from "@agentique-console/core";
import { api } from "@/api/client";
import { useThemeStore } from "@/stores/theme";

export const usePreferences = create<SettingsValues["general"]>(() => ({ theme: "system", sendShortcut: "enter", autoScroll: true, notifications: true }));
export function PreferencesSync() {
  const query = useQuery({ queryKey: ["interface-settings"], queryFn: () => api("interfaceSettings"), refetchOnWindowFocus: true });
  useEffect(() => { if (query.data) { usePreferences.setState(query.data); useThemeStore.getState().setPreference(query.data.theme); } }, [query.data]);
  return null;
}

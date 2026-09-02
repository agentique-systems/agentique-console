import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import "@/styles/globals.css";

import { App } from "@/app/app";
import { Providers, queryClient } from "@/app/providers";
import { createSubscription } from "@/live/subscription";

// The one event subscription, started once at module scope (StrictMode double-mount never re-runs module evaluation).
createSubscription(queryClient).start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);

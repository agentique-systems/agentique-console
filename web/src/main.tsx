import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/globals.css";

import { App } from "@/app/app";
import { Providers, queryClient } from "@/app/providers";
import { bootSpine } from "@/live/boot";

// The one SSE spine, started once at module scope (StrictMode double-mount
// never re-runs module evaluation).
bootSpine(queryClient).start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);

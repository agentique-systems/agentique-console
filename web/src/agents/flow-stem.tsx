/**
 * The flow indicator's DOM: each strip card sits on a stem off the left rail;
 * a flow.delegation pulse sends a dot rail→card (flow.result reversed) and
 * glows the card border once, while the stem keeps a decaying tint. All
 * animation is CSS keyed by the pulse nonce — idle renders a static stem with
 * zero JS per frame. Stale pulses (component mounted after the fact, or a
 * lingering store entry) never animate: anything older than the tint window
 * is ignored on arrival.
 */
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useFlowStore, type FlowPulse } from "@/stores/flow";

/** The dot's travel time — the stem tint holds until it lands. */
const TRAVEL_MS = 600;
/** Full pulse lifetime: travel + glow + tint decay. */
const TINT_MS = 4_000;

export function FlowStem({
  agentSessionId,
  children,
}: {
  agentSessionId: string;
  children: ReactNode;
}) {
  const pulse = useFlowStore((s) => s.byAgentSession[agentSessionId]);
  const [active, setActive] = useState<FlowPulse | null>(null);
  const [tinted, setTinted] = useState(false);

  useEffect(() => {
    if (pulse === undefined) return;
    const age = Date.now() - pulse.at;
    if (age > TINT_MS) return; // stale entry — never re-animate old flow
    setActive(pulse);
    setTinted(true);
    const tintTimer = setTimeout(() => setTinted(false), TRAVEL_MS);
    const doneTimer = setTimeout(() => setActive(null), TINT_MS - age);
    return () => {
      clearTimeout(tintTimer);
      clearTimeout(doneTimer);
    };
  }, [pulse]);

  const outbound = active?.direction === "delegation";

  return (
    <div className="relative pl-4">
      <span
        aria-hidden
        data-testid="flow-stem"
        data-flow={tinted ? active?.direction : undefined}
        className="console-flow-stem absolute left-0 top-1/2 h-px w-4 -translate-y-1/2"
      />
      {active !== null && (
        <span
          key={`dot-${active.nonce}`}
          aria-hidden
          data-testid="flow-dot"
          className={cn(
            "absolute left-0 top-1/2 size-1.5 rounded-full opacity-0",
            outbound
              ? "console-flow-dot-out bg-status-running"
              : "console-flow-dot-in bg-status-completed",
          )}
        />
      )}
      <div
        key={active === null ? "idle" : `card-${active.nonce}`}
        className={cn(
          "rounded-md",
          active !== null &&
            (outbound ? "console-flow-pulse-out" : "console-flow-pulse-in"),
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** One-shot glow lifetime for the conversation pane's right-edge tick. */
const TICK_MS = 900;

/**
 * The conversation pane's right-edge tick: every flow pulse (any agent
 * session) glows it once, pointing the eye toward the strip.
 */
export function FlowEdgeTick() {
  const glow = useFlowStore((s) => s.edgeGlow);
  const [active, setActive] = useState<FlowPulse | null>(null);

  useEffect(() => {
    if (glow === null) return;
    if (Date.now() - glow.at > TICK_MS) return; // stale on mount — skip
    setActive(glow);
    const timer = setTimeout(() => setActive(null), TICK_MS);
    return () => clearTimeout(timer);
  }, [glow]);

  if (active === null) return null;
  return (
    <span
      key={active.nonce}
      aria-hidden
      data-testid="flow-edge-tick"
      className={cn(
        "console-flow-tick absolute right-0 top-1/2 z-10 h-6 w-0.5 -translate-y-1/2 rounded-full",
        active.direction === "delegation"
          ? "bg-status-running"
          : "bg-status-completed",
      )}
    />
  );
}

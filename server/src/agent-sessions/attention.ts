/**
 * The attention policy: whether consuming a durable coordination event NOW can
 * change what the recipient does next — decided once, deterministically, at
 * journal time, from facts the Console already holds (the contract edge, the
 * category, the handoff's own status and risk). Persistence and attention are
 * deliberately decoupled: every handoff is journaled and visible either way;
 * only the ones that pass this policy spend a model turn.
 *
 * A live run burned 39% of its cost on coordinator turns because every routine
 * `update`/`decision` on a spoke→hub edge minted one (or steered an open turn
 * mid-flight, 91 times). The batching machinery already existed — deliveries
 * carry EVERY queued row in one composed prompt — but nothing ever stayed
 * queued long enough to batch.
 */
import type { HandoffDraft } from "@agentique-console/shared";
import type { EdgeSpec } from "./topology-contract.ts";
import type { Category } from "./final-gate.ts";

/** Categories that may wake main (or cross a child boundary) on arrival. */
export const MATERIAL_CATEGORIES = new Set(["milestone", "failure", "final", "decision"]);

/**
 * The four dispositions a delivery row is stamped with:
 * - "interrupt": may steer the recipient's ACTIVE turn — the urgent path.
 * - "wake": earns a model turn at the next boundary (now if the recipient is
 *   idle; when its current turn settles if not).
 * - "defer": durable and visible, but never causes a turn by itself — it rides
 *   along with the recipient's next composed delivery.
 * - "hold": join-held; the pattern engine owns its one flush. Excluded from
 *   ordinary deliveries so a join cannot leak early through an unrelated
 *   delivery, a boot sweep, or a turn boundary.
 */
export type AttentionDisposition = "interrupt" | "wake" | "defer" | "hold";

type HandoffStatus = HandoffDraft["core"]["status"];
type HandoffRisk = HandoffDraft["core"]["risk"];

/**
 * Routine progress: the sender is simply still working. "tests still running",
 * "implemented part 1 of 3", "I decided to rename this local helper". Any
 * terminal, blocked, or needs-verification status is NOT routine — those
 * change what the recipient must integrate, unblock, or verify.
 */
export function routineProgress(category: Category, status: HandoffStatus): boolean {
  return (category === "update" || category === "decision")
    && (status === "pending" || status === "in_progress");
}

/**
 * Urgent: delaying this to the recipient's next natural turn could harm
 * progress or correctness. `failure` concludes work unsuccessfully; `blocked`
 * means the sender cannot proceed; `risk: "high"` is the sender's explicit
 * declaration that the recipient's in-flight work may be invalidated (the
 * operator-answer and revision-notice paths set it for exactly that reason).
 */
function urgent(category: Category, status: HandoffStatus, risk: HandoffRisk): boolean {
  return category === "failure" || status === "blocked" || risk === "high";
}

/**
 * The disposition for one seat-bound delivery. Join edges are engine-owned
 * whatever they carry; the edge's own `attention: "material"` marking (set by
 * pattern builders on report lanes into a controller — never on loop or
 * conversation edges) is what allows routine progress to defer. An edge
 * without the marking keeps the historical semantics: every delivery earns a
 * turn, so no non-hub pattern's convergence changes out from under it.
 */
export function attentionOf(edge: EdgeSpec, category: Category, status: HandoffStatus, risk: HandoffRisk): AttentionDisposition {
  if (edge.advance === "join") return "hold";
  if (urgent(category, status, risk)) return "interrupt";
  if (edge.attention === "material" && routineProgress(category, status)) return "defer";
  return "wake";
}

/**
 * The main sink's gate, refined: the historical MATERIAL_CATEGORIES set minus
 * routine decision RECORDS ("I decided X, continuing" — status pending or
 * in_progress). A decision REQUEST arrives blocked or needs_verification and
 * still wakes; terminal decisions still wake. Deliberately global rather than
 * edge-scoped: main's wake gate has always been one policy for every session,
 * and pre-upgrade contract snapshots carry no edge markings.
 */
export function wakesMain(category: Category, status: HandoffStatus): boolean {
  return MATERIAL_CATEGORIES.has(category) && !routineProgress(category, status);
}

/** Rows that will demand a model turn from the recipient (residency, status). */
export function demandsTurn(attention: string): boolean {
  return attention === "interrupt" || attention === "wake";
}

/**
 * An active delivery row that still demands consumption: delivered rows are
 * mid-turn; queued interrupt/wake/hold rows will earn one. Queued "defer" rows
 * only ever ride along with later deliveries, so closure predicates (session
 * status "reported", operator-debt discharge, run completion) must not wait on
 * them — a run whose last words were routine updates still ends.
 */
export function consumptionPending(row: { status: string; attention: string }): boolean {
  return row.status === "delivered" || row.attention !== "defer";
}

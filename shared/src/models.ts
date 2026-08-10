/**
 * The orchestrator models an operator may choose between, and the default when
 * they choose nothing.
 *
 * This list lives in `shared` for one reason: the picker renders it and the
 * create/patch routes validate against it, and those two must not drift. An id
 * the server accepts but the picker cannot show is unreachable; an id the
 * picker offers but the server rejects is a 400 the operator cannot explain.
 *
 * It is NOT the rotation catalog. `server/model-catalog.ts` maps a model id to
 * a context window, and it must cover every model that can reach a CLI —
 * profile models and per-seat overrides included — not just the three offered
 * here. Adding an entry to this list means adding one there too, or the
 * session silently rotates at the conservative 68K default.
 *
 * Seats are unaffected: they carry their own profile models and never read the
 * orchestrator's.
 */

export interface OrchestratorModel {
  id: string;
  /** Chip text. Short enough to sit in the composer footer. */
  label: string;
  /** One line of muted secondary text in the picker. */
  blurb: string;
}

/**
 * Ordered most to least capable — the picker renders them in this order, and
 * the operator reads the list as a ladder.
 */
export const ORCHESTRATOR_MODELS: readonly OrchestratorModel[] = [
  {
    id: "claude-fable-5",
    label: "fable-5",
    blurb: "deepest reasoning · priced above opus · needs 30-day retention",
  },
  {
    id: "claude-opus-5",
    label: "opus-5",
    blurb: "the default — long-horizon agentic work and delegation",
  },
  {
    id: "claude-sonnet-5",
    label: "sonnet-5",
    blurb: "faster and cheaper, near-opus on most sessions",
  },
];

/**
 * The orchestrator lane's model when nothing overrides it. `CONSOLE_MODEL`
 * still wins server-side, and a session's own `model` wins over both.
 */
export const DEFAULT_ORCHESTRATOR_MODEL = "claude-opus-5";

export function isOrchestratorModel(id: string): boolean {
  return ORCHESTRATOR_MODELS.some((model) => model.id === id);
}

/** The chip label for an id, falling back to the raw id for an unlisted one. */
export function orchestratorModelLabel(id: string): string {
  return ORCHESTRATOR_MODELS.find((model) => model.id === id)?.label ?? id;
}

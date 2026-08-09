/**
 * Turning `core.uncertainty[]` into questions for the operator.
 *
 * Seats fill this field honestly — db-live-2 carried 22 distinct uncertainty
 * items, including "game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK" and
 * "I could not open a browser, so nothing is confirmed rendering" — and until
 * now absolutely nothing in the console read them. The signal the operator
 * wanted was already being written and thrown on the floor.
 *
 * Deterministic and pure: no I/O, no model call, no scoring, no thresholds.
 * Shaped after `checkpoint-gate.ts` for the same reason — a rule you can read
 * is a rule you can argue with, and every pattern list is exported so tests
 * assert on RULES rather than on outcomes.
 *
 * The design constraint that shapes everything else: an unmatched string is NOT
 * escalated. A classifier that guesses produces cards the operator clicks
 * through, and a wrong answer laundered through the decision ledger is worse
 * than no card at all.
 */
import type { HandoffCore, HandoffTrigger } from "@agentique-console/shared";

export type EscalationCategory =
  | "version_substitution"
  | "spec_deviation"
  | "capability_gap"
  | "unverifiable_claim"
  | "ambiguity"
  | "volume";

export interface EscalationItem {
  category: EscalationCategory;
  urgency: "blocking" | "deferred";
  /** The uncertainty string, VERBATIM. Never paraphrased — the seat said it better. */
  text: string;
  /** Named rule that matched; asserted in tests and carried in telemetry. */
  rule: string;
  /** Only for version_substitution: what the console can offer as real options. */
  versions?: { expected: string; shipped: string; dependency: string };
}

export interface EscalationContext {
  trigger: HandoffTrigger;
  // NOTE: deliberately no `status` here — it lives on the core, which is
  // already a parameter. Duplicating it invites the two to disagree, and the
  // first draft of this file promptly did.
  /** Dependency → version the operator named, from the decision ledger. */
  operatorPins: ReadonlyMap<string, string>;
  /** Verbatim operator answers, for distinctive-term matching. */
  operatorConstraints: readonly string[];
  /** The SENDER's real capabilities — turns a claimed limit into a confirmed one. */
  capabilities: {
    shell: boolean;
    browser: boolean;
    screenshots: boolean;
    network: readonly string[];
  };
}

/** A comparative construction: this was swapped for that. */
export const COMPARATIVE_PATTERNS = [
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bnot the (?:specified|requested|named)\b/i,
  /\bdiffers? from\b/i,
  /\bsubstitut/i,
  /\bswapped\b/i,
  /\b(?:upgraded|downgraded|bumped) to\b/i,
  /\bwhere .{0,40}specified\b/i,
  /\balthough .{0,40}(?:asked|specified|named)\b/i,
  /\bthe operator specified\b/i,
  /\bstays? at\b/i,
];

/**
 * Semver AND three.js-style revisions. `r160` is not semver, and it is exactly
 * the token db-live-2 substituted without telling anyone — a naive
 * `\d+\.\d+\.\d+` rule misses the only real case we have.
 */
export const VERSION_TOKEN = /\b(?:\d+\.\d+(?:\.\d+)?|r\d{2,3})\b/g;

export const DEVIATION_PATTERNS = [
  /\bdeviat/i,
  /\bdoes not (?:match|follow|meet)\b/i,
  /\bcontrary to\b/i,
  /\bout of scope\b/i,
  /\bI (?:decided|chose|opted) to\b/i,
  /\bwe chose\b/i,
  /\bI assumed\b/i,
  /\balthough the brief\b/i,
  /\bnot what (?:was )?(?:asked|requested|specified)\b/i,
  /\bwithout asking\b/i,
];

export const CAPABILITY_PATTERNS = [
  /\bcannot\b/i,
  /\bcould not\b/i,
  /\bcan't\b/i,
  /\bunable to\b/i,
  /\bno (?:network|browser|access|permission|egress)\b/i,
  /\bnot available\b/i,
  /\bdenied\b/i,
  /\bECONNREFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND\b/i,
  /\boffline\b/i,
  /\bsandbox\b/i,
  /\bwill not load\b/i,
];

export const UNVERIFIED_PATTERNS = [
  /\bnot (?:verified|confirmed|tested|validated)\b/i,
  /\bunverified\b/i,
  /\bnothing is confirmed\b/i,
  /\bcould not (?:verify|confirm|test|run|reproduce|view)\b/i,
  /\buntested\b/i,
  /\bno evidence\b/i,
  /\bassume[sd]? .{0,30}works\b/i,
  /\bshould work\b/i,
  /\bin theory\b/i,
  /\bdid not run\b/i,
  /\bhave not (?:run|tested|verified)\b/i,
];

export const AMBIGUITY_PATTERNS = [
  /\bunclear\b/i,
  /\bambiguous\b/i,
  /\bnot sure (?:whether|if|which)\b/i,
  /\btwo (?:possible|interpretations)\b/i,
  /\bwhich (?:one|version|approach)\b/i,
  /\bneeds a decision\b/i,
  /\bup to (?:you|the operator)\b/i,
  /\bshould (?:I|we)\b/i,
  /\bwhich would you\b/i,
  // A seat that ends an uncertainty with a question mark is asking, whatever
  // words it used to get there.
  /\?\s*$/,
];

/** A `final` carrying this many uncertainties is itself worth surfacing. */
export const VOLUME_THRESHOLD = 6;

const matches = (patterns: RegExp[], text: string): RegExp | undefined =>
  patterns.find((pattern) => pattern.test(text));

/** Distinctive (>=6 char) words from an operator answer, for constraint matching. */
function distinctiveTerms(constraints: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const constraint of constraints) {
    for (const word of constraint.split(/[^A-Za-z0-9._-]+/)) {
      if (word.length >= 6) terms.add(word.toLowerCase());
    }
  }
  return [...terms];
}

/**
 * A named dependency whose version in this text disagrees with the version the
 * operator pinned. This is the strongest signal available — it does not rely on
 * the seat phrasing anything a particular way.
 */
function pinConflict(text: string, pins: ReadonlyMap<string, string>): EscalationItem["versions"] | undefined {
  const lower = text.toLowerCase();
  for (const [dependency, expected] of pins) {
    if (!lower.includes(dependency)) continue;
    for (const token of text.match(VERSION_TOKEN) ?? []) {
      if (token.toLowerCase() !== expected.toLowerCase()) {
        return { dependency, expected, shipped: token };
      }
    }
  }
  return undefined;
}

/**
 * One pass per uncertainty string, first match wins. Order is deliberate:
 * a version substitution IS a spec deviation, and a spec deviation is more
 * actionable than the capability gap that may have caused it.
 */
export function classifyUncertainty(core: HandoffCore, ctx: EscalationContext): EscalationItem[] {
  const items: EscalationItem[] = [];
  const finalish = ctx.trigger === "final" || core.status === "completed";

  for (const raw of core.uncertainty) {
    const text = raw.trim();
    if (text === "") continue;

    // 1. version_substitution — always blocking. A version the operator named
    //    and did not get is not recoverable after the fact.
    const conflict = pinConflict(text, ctx.operatorPins);
    if (conflict) {
      items.push({ category: "version_substitution", urgency: "blocking", text, rule: "pin_conflict", versions: conflict });
      continue;
    }
    const comparative = matches(COMPARATIVE_PATTERNS, text);
    const versions = [...new Set(text.match(VERSION_TOKEN) ?? [])];
    if (comparative && versions.length >= 2) {
      items.push({
        category: "version_substitution", urgency: "blocking", text,
        rule: `comparative:${comparative.source}`,
        // The FIRST version mentioned in a comparative sentence is normally the
        // one shipped ("stays at r169 … they specified r160"), but the console
        // cannot be sure, so both are offered to the operator verbatim.
        versions: { dependency: dependencyNear(text) ?? "the dependency", shipped: versions[0] as string, expected: versions[1] as string },
      });
      continue;
    }

    // 2. spec_deviation — always blocking.
    const deviation = matches(DEVIATION_PATTERNS, text);
    if (deviation) {
      items.push({ category: "spec_deviation", urgency: "blocking", text, rule: `deviation:${deviation.source}` });
      continue;
    }
    const term = distinctiveTerms(ctx.operatorConstraints)
      .find((candidate) => text.toLowerCase().includes(candidate) && /\bnot\b|\bwithout\b|\bfailed\b/i.test(text));
    if (term !== undefined) {
      items.push({ category: "spec_deviation", urgency: "blocking", text, rule: `constraint:${term}` });
      continue;
    }

    // 3. capability_gap — blocking only when the profile GENUINELY lacks it. If
    //    the seat has the capability it is claiming to lack, it is probably
    //    wrong, and that is the coordinator's problem, not the operator's.
    const capability = matches(CAPABILITY_PATTERNS, text);
    const unverifiedToo = matches(UNVERIFIED_PATTERNS, text) !== undefined;
    // A capability limit the profile does not actually have is a weak claim.
    // If the same sentence ALSO says something went unverified, and this is a
    // final, the operative fact is the missing verification — not the excuse.
    // db-live-2: "I could not view the PNG screenshots myself" on a seat whose
    // profile grants screenshots.
    if (capability && !(finalish && unverifiedToo && !confirmsGap(text, ctx.capabilities))) {
      const confirmed = confirmsGap(text, ctx.capabilities);
      items.push({
        category: "capability_gap",
        urgency: confirmed ? "blocking" : "deferred",
        text,
        rule: `capability:${capability.source}${confirmed ? ":confirmed" : ":claimed"}`,
      });
      continue;
    }

    // 4. unverifiable_claim — the highest-value rule here. Claiming done while
    //    admitting you never verified is exactly what shipped db-live-2, whose
    //    `check` reported "completed" alongside "I could not view the PNG
    //    screenshots myself".
    const unverified = matches(UNVERIFIED_PATTERNS, text);
    if (unverified) {
      items.push({
        category: "unverifiable_claim",
        urgency: finalish ? "blocking" : "deferred",
        text,
        rule: `unverified:${unverified.source}`,
      });
      continue;
    }

    // 5. ambiguity — deferred unless the seat is literally asking.
    const ambiguous = matches(AMBIGUITY_PATTERNS, text);
    if (ambiguous) {
      const asking = text.endsWith("?") || /\bshould (?:I|we)\b/i.test(text);
      items.push({ category: "ambiguity", urgency: asking ? "blocking" : "deferred", text, rule: `ambiguity:${ambiguous.source}` });
      continue;
    }

    // Unmatched: NOT escalated. Deliberate.
  }

  // 6. volume — a synthetic observation about the report itself, not about any
  //    one line. Cheap, honest, and impossible to game by rewording.
  if (finalish && core.uncertainty.length >= VOLUME_THRESHOLD) {
    items.push({
      category: "volume",
      urgency: "deferred",
      text: `This final carries ${core.uncertainty.length} unresolved uncertainties.`,
      rule: "volume",
    });
  }

  return items;
}

/** The token immediately before a version, when there is one — "three r169". */
function dependencyNear(text: string): string | undefined {
  const match = /([A-Za-z][A-Za-z0-9._-]{1,40})[\s@]+v?(?:\d+\.\d+|r\d{2,3})\b/.exec(text);
  return match?.[1]?.toLowerCase();
}

/**
 * Whether the seat's claimed limit matches a capability its profile genuinely
 * lacks. A `visual-reviewer` saying "I could not open a browser" is reporting a
 * bug; a `researcher` saying it is reporting a fact.
 */
function confirmsGap(text: string, capabilities: EscalationContext["capabilities"]): boolean {
  const lower = text.toLowerCase();
  if (/\bnetwork|cdn|unpkg|registry|fetch|egress|resolve|offline|load\b/.test(lower) && capabilities.network.length === 0) return true;
  if (/\bbrowser|chrome|render|page\b/.test(lower) && !capabilities.browser) return true;
  if (/\bscreenshot\b/.test(lower) && !capabilities.screenshots) return true;
  if (/\bshell|bash|process|command\b/.test(lower) && !capabilities.shell) return true;
  return false;
}

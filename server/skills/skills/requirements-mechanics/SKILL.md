---
name: requirements-mechanics
description: Working the requirement graph — staged proposals, the outline grammar and id-tag rules, decompose-vs-amend, and scoped amendments that keep every operator card a reviewable bite.
version: 1.0.0
provenance: moved from the standing orchestrator surfaces (agent-stack simplification, Stage 7b)
status: validated
requires:
  tools: []
whenToUse: Before propose_requirements (first proposal or amendment), and when deciding between decompose_requirement and an amendment.
costNote: ~60 lines when invoked.
---

# Requirements mechanics

The invariants live in the tool descriptions: the approved text governs,
statuses are semantic claims reported on leaves with evidence, and when
reality invalidates a statement's meaning you amend — never silently
redefine done. This skill is the procedure.

## Stage the commitment

- The FIRST proposal is the vision prose (## Context, ## Goals,
  ## Out of scope) plus COARSE top-level requirements a reviewer can check
  — not an exhaustive enumeration. A large area earns one statement now and
  a scoped amendment when you commission it or when discovery lands.
- Elaborate one subtree with `scopeId` (document = that subtree's children
  only, structure-only). Amend the prose alone with `intent: true` (empty
  ## Requirements). Every kind bumps the revision: a changed vision or
  subtree invalidates completion currency deliberately.
- Each card the operator approves should stay a reviewable bite; the card
  renders the scope and a server-computed change summary.
- While specifying, sweep the uncertainty map across every dimension of the
  outcome — intent, UX, behavior, scope, architecture, constraints,
  performance, reliability, security, edge cases, environment, the
  definition of excellent. Consequential uncertainties get resolved;
  everything else gets its default recorded with record_assumption.

## Outline grammar

- One declarative, checkable statement per `- ` line — what must be TRUE of
  the finished work, never how. Nest where structure helps (2-space
  indents). Children compose "all" by default; mark `(any of)` when one
  sufficient alternative establishes the parent.
- Declare a verification expectation inline where stakes demand it:
  `(verify: independent)` or `(verify: operator)` before the statement.
- KEEP the `rN:` id tags on lines you are keeping — dropping a tag RETIRES
  that requirement (and its refinement children cascade with it); a new
  line carries no tag and gets its id minted on approval.
- Statuses and evidence survive an amendment on unchanged statements; an
  edited statement resets its node to open.

## Decompose vs amend

- decompose_requirement refines HOW a committed obligation is discharged —
  child statements below it, no approval needed, journaled and attributed.
- Editing a statement, retiring a node, or adding a new top-level
  obligation changes what counts as success: that is an amendment through
  propose_requirements, and the operator approves it.
- The operator may EDIT the outline on the card; their text governs. On
  approval, read the returned canonical document — the ids minted there are
  what commissions, the ledger, and report_requirement reference.

## After an amendment

Running sessions were briefed under the old revision. The approval result
marks which sessions the change actually touches; judge materiality per
session — steer with send_to_coordinator (category "update"), interrupt for
urgent redirects, or let immaterial ones finish.

When the change touches prior evidence or active work, the Console also
persists the transitive affected set — dependents (through depends_on,
ancestors included), descendants, suspect terminal claims, affected sessions
and requirement-linked tasks — as a durable change impact (the approval
result and read_requirements carry it). The Console computed WHAT; you judge
MEANING per item: reopening or re-verifying a suspect claim through
report_requirement clears it mechanically, archiving a session clears it,
and every other judgment is recorded with reconcile_change_impact (stands /
superseded for claims; unaffected / steered / interrupted / superseded for
sessions, each with why). The run will not propose completion while an
impact is open — reconciliation is part of landing the amendment, not
optional bookkeeping. The same ledger records falsified assumptions and
withdrawn terminal claims that leave stale dependents behind.

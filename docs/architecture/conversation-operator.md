# Conversation admission and operator experience

This document extends the execution model for the conversation-first console.
Work Run invariants in the execution model remain binding. The exceptions below
apply only to the internal conversation context.

The operator communicates through one Conversation thread and one Send action.
Runs are internal execution records, reachable through optional inspection. The
primary UI presents history, New conversation, a composer, and inline
clarification, progress, results, Artifacts, errors, Decisions, signoff,
publication, and pause/resume/cancel controls. Workspace and model settings do
not require a work launch.

## Admission and retries

`ConversationService` admits messages transactionally. A client supplies a
`requestId`; `(conversationId, requestId)` has one durable receipt containing
its request digest and response. Replaying it returns that response; reusing
the key with different content is a conflict. Message, initial execution
context or queued input, and receipt commit together. The browser retains an
outbox before Send and replays the original body after reload or an uncertain
response. Older clients may omit the key, but cannot then obtain transport
retry deduplication. Messages remain append-only.

## Conversation context

A Conversation has at most one active work Run and one active internal
conversation context. The latter is a Run with immutable `mode: conversation`,
`kind: other`, its own Budget and Usage, and no final reserve. It holds no
Workspace preparation, Snapshot, or worktree and does not claim
`Conversation.activeRunId`. This qualifies the work-Run creation rules:
work Runs retain every preparation, verification, signoff, and publication
guarantee. A unique index prevents two active conversation contexts.

Conversation contexts use the same root position, Invocation preparation,
Attempt executor, provider registry, reservations, resource governor,
scheduler, retry, recovery, and control services as work. There is no second
provider loop or scheduler. Chatting requires no initial commit or completion
configuration; work preparation is deferred until execution is requested.

The conversation context has no native or MCP capabilities and only
`return_result`. The model returns a typed `conversation: { reply, work }`:
`reply` is the answer, and `work` is null or a self-contained execution request.
Greetings, clarification and questions about results keep `work` null and reuse
the context. Only a completed Orchestrator result may contain this field; only
a conversation context may request work. It cannot approve, waive, sign off,
publish, or invoke work tools. No text parser classifies operator intent.

## Dispatch and safeguards

The host projects committed results after scheduler passes and on restart.
A typed work request with a new operator input either launches through
`RunLaunchService`, reusing the original message, or queues steering to the
active work Run. A dispatch receipt, domain writes, and reply commit atomically.
Active work rejects dispatch at pause, verification, signoff and blocking
Decision boundaries; the inline controls remain authoritative. A domain refusal is
recorded with a visible explanation. Infrastructure failures retry from the
committed result. A conversation context paused after its result commits holds
its dispatch until Resume; cancellation permanently refuses it. Work Orchestrator
replies also commit with successful Attempt settlement, so progress is visible before subsequent work finishes. Final
reports remain canonical Artifacts and appear inline.

Conversation input never resolves a Decision, grows a Budget, clears a pause,
accepts signoff, or publishes. These remain explicit domain operations. Signoff
and publication keep separate confirmations. A terminal work Run is never
reopened; a later execution request creates another work Run in the thread.

## Context and storage

Orchestrator manifests include an immutable recent Conversation context: up to
40 messages within 48,000 characters and the latest 12 execution records with
work status. Older messages remain durable and pageable; the manifest says
when history was omitted. Workers and Evaluators receive no conversation
history. This qualifies the former blanket history exclusion in execution-model
section 6.2; diagnostic transcripts and provider continuation payloads remain
excluded. Artifact authorization remains unchanged.

The configured model is pinned for the conversation context and inherited by
new work. Existing work retains its model. A new Conversation selects a different
model. Budget exhaustion requires an explicit operator decision; another Send
does not increase the Budget or resume paused execution.

Schema version 3 adds a nullable Run mode, message receipts and dispatch
receipts, with immutable receipt records. Existing work Runs, manifests, Events
and inspection/control routes retain their semantics. Version 1 and 2 databases migrate forward. Regression
tests exercise admission, restart, reply projection, dispatch receipts and
safeguards. Browser tests use real HTTP, SQLite, git and subprocess checks with
deterministic provider fixtures; they do not establish live-model routing quality.

## Instance configuration

Settings is the single browser configuration area and remains accessible before
workspace selection. Its typed service applies validated saved application
settings and workspace overrides to the existing provider registry and domain
services. Deployment-enforced fields remain locked. Supported workspace
overrides outrank saved instance defaults; immutable conversation and work
execution identities take precedence once selected. Default changes never
rewrite historical selections or manifests.

Provider connection/catalog edits that affect active dependencies are refused.
Process-captured agent limits, capability restrictions and tool timeouts require
restart; both saved and running values are inspectable. Settings cannot weaken
mandatory domain approval, deterministic verification, signoff or publication
rules. MCP discovery supplies connectivity evidence and does not grant tools.

Schema version 4 adds an atomic versioned settings document. Credentials use
authenticated encryption with deployment-owned key material stored separately
from the database. Administrative routes enforce local operator access or an
explicit deployment token, same-origin requests and protected credential
transport. See [Settings](../settings.md) for the full field inventory,
provisioning, precedence, recovery and verification contract.

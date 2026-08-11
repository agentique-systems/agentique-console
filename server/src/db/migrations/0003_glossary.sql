PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`mode` text NOT NULL,
	`phase` text DEFAULT 'planning' NOT NULL,
	`lifecycle` text DEFAULT 'open' NOT NULL,
	`purpose` text DEFAULT 'work' NOT NULL,
	`subject_key` text,
	`sdk_session_id` text,
	`sdk_generation` integer DEFAULT 0 NOT NULL,
	`sdk_turn_count` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`memory` text DEFAULT '' NOT NULL,
	`latest_handoff_id` text,
	`cumulative_cost_usd` real DEFAULT 0 NOT NULL,
	`cumulative_api_duration_ms` integer DEFAULT 0 NOT NULL,
	`run_state` text DEFAULT 'active' NOT NULL,
	`run_base_commit` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_sessions_mode" CHECK("__new_user_sessions"."mode" IN ('execute','plan_execute')),
	CONSTRAINT "user_sessions_phase" CHECK("__new_user_sessions"."phase" IN ('planning','executing')),
	CONSTRAINT "user_sessions_lifecycle" CHECK("__new_user_sessions"."lifecycle" IN ('open','archived')),
	CONSTRAINT "user_sessions_purpose" CHECK("__new_user_sessions"."purpose" IN ('work','profile_manager')),
	CONSTRAINT "user_sessions_run_state" CHECK("__new_user_sessions"."run_state" IN ('active','awaiting_signoff','completed'))
);
--> statement-breakpoint
INSERT INTO `__new_user_sessions`("id", "workspace_id", "title", "mode", "phase", "lifecycle", "purpose", "subject_key", "sdk_session_id", "sdk_generation", "sdk_turn_count", "context_tokens", "memory", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "run_state", "run_base_commit", "model", "created_at", "updated_at") SELECT "id", "workspace_id", "title", "mode", "phase", "status", "purpose", "subject_key", "sdk_session_id", "sdk_generation", "sdk_turn_count", "context_tokens", "memory", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "run_state", "run_base_commit", "model", "created_at", "updated_at" FROM `user_sessions`;--> statement-breakpoint
DROP TABLE `user_sessions`;--> statement-breakpoint
ALTER TABLE `__new_user_sessions` RENAME TO `user_sessions`;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`title` text NOT NULL,
	`lifecycle` text DEFAULT 'open' NOT NULL,
	`pattern` text DEFAULT 'hub_and_spoke' NOT NULL,
	`topology` text DEFAULT '{}' NOT NULL,
	`parent_agent_session_id` text,
	`parent_controller_agent` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_sessions_lifecycle" CHECK("__new_agent_sessions"."lifecycle" IN ('open','archived'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "user_session_id", "title", "lifecycle", "pattern", "topology", "parent_agent_session_id", "parent_controller_agent", "depth", "created_at", "updated_at") SELECT "id", "user_session_id", "title", "status", "pattern", "topology", "parent_agent_session_id", "parent_controller_seat", "depth", "created_at", "updated_at" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`agent_session_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`instructions` text NOT NULL,
	`model` text,
	`profile_id` text DEFAULT 'explorer' NOT NULL,
	`profile_snapshot` text DEFAULT '{}' NOT NULL,
	`ownership` text DEFAULT '[]' NOT NULL,
	`sdk_session_id` text,
	`last_active_at` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`latest_handoff_id` text,
	`cumulative_cost_usd` real DEFAULT 0 NOT NULL,
	`cumulative_api_duration_ms` integer DEFAULT 0 NOT NULL,
	`last_decision_at` text,
	`worktree_path` text,
	`worktree_base_commit` text,
	`worktree_branch` text,
	`ord` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_session_id`, `name`),
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("agent_session_id", "name", "role", "instructions", "model", "profile_id", "profile_snapshot", "ownership", "sdk_session_id", "last_active_at", "generation", "turn_count", "context_tokens", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "last_decision_at", "worktree_path", "worktree_base_commit", "worktree_branch", "ord", "created_at") SELECT "agent_session_id", "name", "pattern_role", "instructions", "model", "profile_id", "profile_snapshot", "ownership", "sdk_session_id", "last_active_at", "generation", "turn_count", "context_tokens", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "last_decision_at", "worktree_path", "worktree_base_commit", "worktree_branch", "ord", "created_at" FROM `participants`;--> statement-breakpoint
DROP TABLE `participants`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
ALTER TABLE `provider_entries_v2` RENAME TO `provider_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Data: the reserved coordination agent is now NAMED 'coordinator'. The
-- messages.speaker_kind value 'orchestrator' is the MAIN-LANE VOICE and is
-- deliberately untouched; only agent-transcript speaker NAMES rename.
UPDATE `agents` SET `name` = 'coordinator' WHERE `name` = 'orchestrator';--> statement-breakpoint
UPDATE `messages` SET `speaker_name` = 'coordinator' WHERE `session_kind` = 'agent' AND `speaker_name` = 'orchestrator';--> statement-breakpoint
UPDATE `mailbox_deliveries` SET `sender` = 'coordinator' WHERE `sender` = 'orchestrator';--> statement-breakpoint
UPDATE `mailbox_deliveries` SET `recipient` = 'coordinator' WHERE `recipient` = 'orchestrator';--> statement-breakpoint
UPDATE `handoff_records` SET `sender` = 'coordinator' WHERE `sender` = 'orchestrator';--> statement-breakpoint
UPDATE `handoff_records` SET `recipient` = 'coordinator' WHERE `recipient` = 'orchestrator';--> statement-breakpoint
UPDATE `agent_sessions` SET `parent_controller_agent` = 'coordinator' WHERE `parent_controller_agent` = 'orchestrator';--> statement-breakpoint
UPDATE `interactions` SET `participant` = 'coordinator' WHERE `participant` = 'orchestrator' AND `agent_session_id` IS NOT NULL;--> statement-breakpoint
-- Data: rename every historical events.type onto the new union.
UPDATE `events` SET `type` = CASE `type`
	WHEN 'user_session.message' THEN 'user_session.message.appended'
	WHEN 'agent_session.message' THEN 'agent_session.message.appended'
	WHEN 'user_session.tool.call' THEN 'user_session.tool.called'
	WHEN 'user_session.tool.result' THEN 'user_session.tool.completed'
	WHEN 'agent_session.tool.call' THEN 'agent_session.tool.called'
	WHEN 'agent_session.tool.result' THEN 'agent_session.tool.completed'
	WHEN 'user_session.runtime' THEN 'user_session.runtime.noted'
	WHEN 'agent_session.runtime' THEN 'agent_session.runtime.noted'
	WHEN 'agent_session.status' THEN 'agent_session.status.changed'
	WHEN 'agent_session.mailbox' THEN 'agent_session.delivery.updated'
	WHEN 'agent_session.watchdog' THEN 'agent_session.watchdog.tripped'
	WHEN 'agent_session.unreported' THEN 'agent_session.closeout.forced'
	WHEN 'governance.tool.denied' THEN 'tool.denied'
	WHEN 'handoff.discrepancy' THEN 'handoff.discrepancy.reported'
	WHEN 'task_dependency.created' THEN 'task.dependency.created'
	WHEN 'task_dependency.deleted' THEN 'task.dependency.deleted'
	WHEN 'flow.delegation' THEN 'agent_session.delegation.sent'
	WHEN 'flow.result' THEN 'agent_session.result.returned'
	WHEN 'agent.state' THEN 'agent_session.activity.changed'
	ELSE `type` END
WHERE `type` IN ('user_session.message','agent_session.message','user_session.tool.call','user_session.tool.result','agent_session.tool.call','agent_session.tool.result','user_session.runtime','agent_session.runtime','agent_session.status','agent_session.mailbox','agent_session.watchdog','agent_session.unreported','governance.tool.denied','handoff.discrepancy','task_dependency.created','task_dependency.deleted','flow.delegation','flow.result','agent.state');--> statement-breakpoint
-- Data: the seat-name value 'orchestrator' inside event payloads. Scoped to
-- agent-session events — a user-session payload's participant 'orchestrator'
-- is the main-lane voice and stays.
UPDATE `events` SET `payload` = json_set(`payload`, '$.participant', 'coordinator') WHERE `agent_session_id` IS NOT NULL AND json_extract(`payload`, '$.participant') = 'orchestrator';--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.seat', 'coordinator') WHERE `agent_session_id` IS NOT NULL AND json_extract(`payload`, '$.seat') = 'orchestrator';--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.sender', 'coordinator') WHERE `agent_session_id` IS NOT NULL AND json_extract(`payload`, '$.sender') = 'orchestrator';--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.recipient', 'coordinator') WHERE `agent_session_id` IS NOT NULL AND json_extract(`payload`, '$.recipient') = 'orchestrator';--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.byParticipant', 'coordinator') WHERE `agent_session_id` IS NOT NULL AND json_extract(`payload`, '$.byParticipant') = 'orchestrator';--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.output.entrySeat', 'coordinator') WHERE json_extract(`payload`, '$.output.entrySeat') = 'orchestrator';--> statement-breakpoint
-- Data: payload key renames, scoped to the types that carry each key.
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.participant'), '$.agent', json_extract(`payload`, '$.participant'))
WHERE `type` IN ('agent_session.turn.started','agent_session.turn.settled','agent_session.tool.called','agent_session.tool.completed','agent_session.runtime.noted','agent_session.context.rotated','agent_session.process.started','agent_session.process.output','agent_session.process.exited','agent_session.watchdog.tripped','agent_session.activity.changed','usage.recorded','user_session.retry.recorded','agent_session.retry.recorded','handoff.consumed','handoff.checkpoint.failed','tool.denied','user_session.question.asked')
	AND json_extract(`payload`, '$.participant') IS NOT NULL;--> statement-breakpoint
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.seat'), '$.agent', json_extract(`payload`, '$.seat'))
WHERE `type` IN ('agent_session.worktree.created','agent_session.worktree.merged','agent_session.worktree.merge_failed','agent_session.worktree.discarded')
	AND json_extract(`payload`, '$.seat') IS NOT NULL;--> statement-breakpoint
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.participants'), '$.agents', json_extract(`payload`, '$.participants'))
WHERE `type` = 'agent_session.created' AND json_extract(`payload`, '$.participants') IS NOT NULL;--> statement-breakpoint
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.byParticipant'), '$.byAgent', json_extract(`payload`, '$.byParticipant'))
WHERE `type` = 'agent_session.child.spawned' AND json_extract(`payload`, '$.byParticipant') IS NOT NULL;--> statement-breakpoint
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.seatReports'), '$.agentReports', json_extract(`payload`, '$.seatReports'))
WHERE `type` = 'agent_session.closeout.forced' AND json_extract(`payload`, '$.seatReports') IS NOT NULL;--> statement-breakpoint
-- Data: legacy bare `sessionId` payload ids, so the web tolerant accessor can die.
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.sessionId'), '$.userSessionId', json_extract(`payload`, '$.sessionId'))
WHERE (`type` LIKE 'user_session.%' OR `type` LIKE 'run.%' OR `type` LIKE 'operator.%' OR `type` = 'tool.denied')
	AND json_extract(`payload`, '$.sessionId') IS NOT NULL AND json_extract(`payload`, '$.userSessionId') IS NULL;--> statement-breakpoint
UPDATE `events` SET `payload` = json_insert(json_remove(`payload`, '$.sessionId'), '$.agentSessionId', json_extract(`payload`, '$.sessionId'))
WHERE `type` IN ('agent_session.tool.called','agent_session.tool.completed')
	AND json_extract(`payload`, '$.sessionId') IS NOT NULL AND json_extract(`payload`, '$.agentSessionId') IS NULL;--> statement-breakpoint
-- Data: frozen topology snapshots carry the old advance modes and limits keys.
UPDATE `agent_sessions` SET `topology` = replace(replace(`topology`, '"advance":"router"', '"advance":"immediate"'), '"advance":"console"', '"advance":"join"') WHERE `topology` LIKE '%"advance":%';--> statement-breakpoint
UPDATE `agent_sessions` SET `topology` = replace(replace(`topology`, '"minSeats":', '"minAgents":'), '"maxSeats":', '"maxAgents":') WHERE `topology` LIKE '%"minSeats":%';--> statement-breakpoint
UPDATE `agent_sessions` SET `topology` = replace(`topology`, '(e.g. \"orchestrator\")', '(e.g. \"coordinator\")') WHERE `topology` LIKE '%orchestrator%';--> statement-breakpoint
UPDATE `agent_sessions` SET `topology` = replace(`topology`, 'address only orchestrator.', 'address only coordinator.') WHERE `topology` LIKE '%address only orchestrator.%';

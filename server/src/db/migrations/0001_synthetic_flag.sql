PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE `interactions` SET `source` = 'console' WHERE `source` = 'uncertainty';--> statement-breakpoint
CREATE TABLE `__new_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text,
	`participant` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`urgency` text DEFAULT 'blocking' NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`recommendation` text,
	`dedupe_key` text,
	`allow_free_text` integer DEFAULT false NOT NULL,
	`detached` integer DEFAULT false NOT NULL,
	`flushed_at` text,
	`payload` text NOT NULL,
	`response` text,
	`tool_use_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "interactions_kind" CHECK("__new_interactions"."kind" IN ('question','plan_approval')),
	CONSTRAINT "interactions_status" CHECK("__new_interactions"."status" IN ('pending','answered','rejected','dismissed','stale')),
	CONSTRAINT "interactions_urgency" CHECK("__new_interactions"."urgency" IN ('blocking','deferred')),
	CONSTRAINT "interactions_source" CHECK("__new_interactions"."source" IN ('agent','console'))
);
--> statement-breakpoint
INSERT INTO `__new_interactions`("id", "user_session_id", "agent_session_id", "participant", "kind", "status", "urgency", "source", "recommendation", "dedupe_key", "allow_free_text", "detached", "flushed_at", "payload", "response", "tool_use_id", "created_at", "resolved_at") SELECT "id", "user_session_id", "agent_session_id", "participant", "kind", "status", "urgency", "source", "recommendation", "dedupe_key", "allow_free_text", "detached", "flushed_at", "payload", "response", "tool_use_id", "created_at", "resolved_at" FROM `interactions`;--> statement-breakpoint
DROP TABLE `interactions`;--> statement-breakpoint
ALTER TABLE `__new_interactions` RENAME TO `interactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `interactions_session_status` ON `interactions` (`user_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `interactions_agent_open` ON `interactions` (`agent_session_id`,`status`,`urgency`);--> statement-breakpoint
ALTER TABLE `handoff_records` ADD `synthetic` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE handoff_records SET synthetic = 1 WHERE json_extract(extension,'$.data.consoleSynthesized') = true OR json_extract(extension,'$.data.consoleSynthesized') = 1;
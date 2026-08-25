CREATE TABLE `continuation_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_user_session_id` text NOT NULL,
	`at_revision` integer NOT NULL,
	`decision_count` integer DEFAULT 0 NOT NULL,
	`run_state` text NOT NULL,
	`synthesis` text,
	`facts` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "continuation_checkpoints_run_state" CHECK("continuation_checkpoints"."run_state" IN ('active','awaiting_signoff','completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `continuation_checkpoints_source` ON `continuation_checkpoints` (`source_user_session_id`);--> statement-breakpoint
CREATE INDEX `continuation_checkpoints_project` ON `continuation_checkpoints` (`project_id`);
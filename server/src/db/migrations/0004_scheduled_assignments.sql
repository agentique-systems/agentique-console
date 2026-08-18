CREATE TABLE `scheduled_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`category` text DEFAULT 'assignment' NOT NULL,
	`handoff` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`status_reason` text,
	`dispatched_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "scheduled_assignments_category" CHECK("scheduled_assignments"."category" IN ('assignment','update','milestone','failure','final','decision')),
	CONSTRAINT "scheduled_assignments_status" CHECK("scheduled_assignments"."status" IN ('scheduled','dispatched','canceled')),
	CONSTRAINT "scheduled_assignments_status_reason" CHECK("scheduled_assignments"."status_reason" IS NULL OR "scheduled_assignments"."status_reason" IN ('replaced','task_deleted','task_completed','session_archived','canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_assignments_live_task` ON `scheduled_assignments` (`task_id`) WHERE status = 'scheduled';--> statement-breakpoint
CREATE INDEX `scheduled_assignments_session` ON `scheduled_assignments` (`user_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `scheduled_assignments_agent_session` ON `scheduled_assignments` (`agent_session_id`,`status`);
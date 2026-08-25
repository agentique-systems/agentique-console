CREATE TABLE `decision_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`issue_key` text,
	`subject` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`requirement_ids` text DEFAULT '[]' NOT NULL,
	`resolutions` text DEFAULT '[]' NOT NULL,
	`superseded_by_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	CONSTRAINT "decision_issues_status" CHECK("decision_issues"."status" IN ('open','resolved','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decision_issues_open_key` ON `decision_issues` (`project_id`,`issue_key`) WHERE status = 'open' AND issue_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `decision_issues_project` ON `decision_issues` (`project_id`,`status`);--> statement-breakpoint
ALTER TABLE `interactions` ADD `issue_id` text;--> statement-breakpoint
CREATE INDEX `interactions_issue` ON `interactions` (`issue_id`);
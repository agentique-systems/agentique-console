CREATE TABLE `assumptions` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text NOT NULL,
	`agent_session_id` text,
	`interaction_id` text,
	`actor` text NOT NULL,
	`resolution_note` text,
	`resolution_evidence` text,
	`resolved_ord` integer,
	`created_at` text NOT NULL,
	`resolved_at` text,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assumptions_status" CHECK("assumptions"."status" IN ('open','confirmed','falsified','retired')),
	CONSTRAINT "assumptions_source" CHECK("assumptions"."source" IN ('operator','main','agent'))
);
--> statement-breakpoint
CREATE INDEX `assumptions_project` ON `assumptions` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `requirement_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_by_actor` text NOT NULL,
	`agent_session_id` text,
	`note` text,
	`created_at` text NOT NULL,
	`retired_at` text,
	CONSTRAINT "requirement_links_to_kind" CHECK("requirement_links"."to_kind" IN ('requirement','assumption')),
	CONSTRAINT "requirement_links_kind" CHECK("requirement_links"."kind" IN ('depends_on','conflicts_with','rests_on'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirement_links_pair` ON `requirement_links` (`project_id`,`kind`,`from_id`,`to_kind`,`to_id`);--> statement-breakpoint
CREATE INDEX `requirement_links_project` ON `requirement_links` (`project_id`,`retired_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_requirement_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`verified_by` text NOT NULL,
	`actor` text NOT NULL,
	`agent_session_id` text,
	`at_revision` integer NOT NULL,
	`ord` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	CONSTRAINT "requirement_status_changes_verified_by" CHECK("__new_requirement_status_changes"."verified_by" IN ('self','independent','operator','console'))
);
--> statement-breakpoint
INSERT INTO `__new_requirement_status_changes`("id", "project_id", "user_session_id", "requirement_id", "from_status", "to_status", "evidence", "verified_by", "actor", "agent_session_id", "at_revision", "ord", "note", "created_at")
	SELECT "id", "project_id", "user_session_id", "requirement_id", "from_status", "to_status", "evidence", "verified_by", "actor", "agent_session_id", "at_revision",
		(SELECT count(*) FROM `requirement_status_changes` AS b WHERE b.rowid <= a.rowid), "note", "created_at"
	FROM `requirement_status_changes` AS a;
--> statement-breakpoint
DROP TABLE `requirement_status_changes`;--> statement-breakpoint
ALTER TABLE `__new_requirement_status_changes` RENAME TO `requirement_status_changes`;--> statement-breakpoint
CREATE INDEX `requirement_status_changes_req` ON `requirement_status_changes` (`project_id`,`requirement_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
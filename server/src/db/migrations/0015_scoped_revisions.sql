PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_requirement_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text DEFAULT 'full' NOT NULL,
	`scope_id` text,
	`base_revision` integer NOT NULL,
	`document` text NOT NULL,
	`graph` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`origin` text DEFAULT 'main' NOT NULL,
	`interaction_id` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_revisions_status" CHECK("__new_requirement_revisions"."status" IN ('draft','approved','superseded','rejected')),
	CONSTRAINT "requirement_revisions_origin" CHECK("__new_requirement_revisions"."origin" IN ('main','operator_edited')),
	CONSTRAINT "requirement_revisions_kind" CHECK("__new_requirement_revisions"."kind" IN ('full','intent','subtree'))
);
--> statement-breakpoint
INSERT INTO `__new_requirement_revisions`("id", "project_id", "user_session_id", "revision", "kind", "scope_id", "base_revision", "document", "graph", "change_note", "status", "origin", "interaction_id", "created_at", "approved_at") SELECT "id", "project_id", "user_session_id", "revision", 'full', NULL, "base_revision", "document", "graph", "change_note", "status", "origin", "interaction_id", "created_at", "approved_at" FROM `requirement_revisions`;--> statement-breakpoint
DROP TABLE `requirement_revisions`;--> statement-breakpoint
ALTER TABLE `__new_requirement_revisions` RENAME TO `requirement_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `requirement_revisions_project` ON `requirement_revisions` (`project_id`,`revision`);
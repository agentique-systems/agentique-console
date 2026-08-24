CREATE TABLE `change_impacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`at_revision` integer NOT NULL,
	`computed_at_ord` integer NOT NULL,
	`note` text,
	`affected` text NOT NULL,
	`dispositions` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "change_impacts_source_kind" CHECK("change_impacts"."source_kind" IN ('amendment','assumption_falsified','claim_withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_impacts_source` ON `change_impacts` (`project_id`,`source_kind`,`source_ref`);--> statement-breakpoint
CREATE INDEX `change_impacts_project` ON `change_impacts` (`project_id`);
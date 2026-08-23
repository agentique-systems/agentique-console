CREATE TABLE `requirement_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`source` text NOT NULL,
	`handoff_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "requirement_delegations_source" CHECK("requirement_delegations"."source" IN ('commission','assignment','child'))
);
--> statement-breakpoint
CREATE INDEX `requirement_delegations_session` ON `requirement_delegations` (`agent_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `requirement_delegations_pair` ON `requirement_delegations` (`agent_session_id`,`requirement_id`);--> statement-breakpoint
CREATE TABLE `requirement_nodes` (
	`id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`parent_id` text,
	`ord` integer NOT NULL,
	`statement` text NOT NULL,
	`composition` text DEFAULT 'all' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'committed' NOT NULL,
	`introduced_in_revision` integer NOT NULL,
	`retired_in_revision` integer,
	`refined_by_agent_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_session_id`, `id`),
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_nodes_status" CHECK("requirement_nodes"."status" IN ('open','satisfied','violated','infeasible','retired')),
	CONSTRAINT "requirement_nodes_composition" CHECK("requirement_nodes"."composition" IN ('all','any')),
	CONSTRAINT "requirement_nodes_origin" CHECK("requirement_nodes"."origin" IN ('committed','refinement'))
);
--> statement-breakpoint
CREATE INDEX `requirement_nodes_live` ON `requirement_nodes` (`user_session_id`,`retired_in_revision`);--> statement-breakpoint
CREATE TABLE `requirement_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`graph` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`origin` text DEFAULT 'main' NOT NULL,
	`interaction_id` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_revisions_status" CHECK("requirement_revisions"."status" IN ('draft','approved','superseded','rejected')),
	CONSTRAINT "requirement_revisions_origin" CHECK("requirement_revisions"."origin" IN ('main','operator_edited'))
);
--> statement-breakpoint
CREATE INDEX `requirement_revisions_session` ON `requirement_revisions` (`user_session_id`,`revision`);--> statement-breakpoint
CREATE TABLE `requirement_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`verified_by` text NOT NULL,
	`actor` text NOT NULL,
	`agent_session_id` text,
	`at_revision` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	CONSTRAINT "requirement_status_changes_verified_by" CHECK("requirement_status_changes"."verified_by" IN ('self','independent','operator','console'))
);
--> statement-breakpoint
CREATE INDEX `requirement_status_changes_req` ON `requirement_status_changes` (`user_session_id`,`requirement_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `requirement_id` text;
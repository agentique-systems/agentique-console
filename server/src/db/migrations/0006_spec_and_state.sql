CREATE TABLE `orchestration_state_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`trigger` text NOT NULL,
	`strategy` text DEFAULT '' NOT NULL,
	`strategy_why` text DEFAULT '' NOT NULL,
	`uncertainties` text DEFAULT '[]' NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`risks` text DEFAULT '[]' NOT NULL,
	`note` text,
	`completion` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orchestration_state_trigger" CHECK("orchestration_state_revisions"."trigger" IN ('commission','discovery','alarm','direction_change','completion','operator'))
);
--> statement-breakpoint
CREATE INDEX `orchestration_state_session` ON `orchestration_state_revisions` (`user_session_id`,`revision`);--> statement-breakpoint
CREATE TABLE `spec_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`origin` text DEFAULT 'main' NOT NULL,
	`interaction_id` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_revisions_status" CHECK("spec_revisions"."status" IN ('draft','approved','superseded','rejected')),
	CONSTRAINT "spec_revisions_origin" CHECK("spec_revisions"."origin" IN ('main','operator_edited'))
);
--> statement-breakpoint
CREATE INDEX `spec_revisions_session` ON `spec_revisions` (`user_session_id`,`revision`);
CREATE TABLE `minted_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`base_profile_id` text NOT NULL,
	`base_revision` text NOT NULL,
	`profile` text NOT NULL,
	`why` text,
	`created_at` text NOT NULL
);

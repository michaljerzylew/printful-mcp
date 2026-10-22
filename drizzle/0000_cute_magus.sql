CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`redirect_uri` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`grant_id` text NOT NULL,
	`credential` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expiry` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`credential` text NOT NULL,
	`access_hash` text NOT NULL,
	`access_expires` integer NOT NULL,
	`refresh_hash` text NOT NULL,
	`refresh_expires` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_access_hash_unique` ON `oauth_grants` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_hash_unique` ON `oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE TABLE `oauth_form_nonces` (
	`nonce_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_form_expiry` ON `oauth_form_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_rate_limits` (
	`rate_key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_rate_expiry` ON `oauth_rate_limits` (`expires_at`);
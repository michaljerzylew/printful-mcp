ALTER TABLE `oauth_grants` ADD `code_hash` text;--> statement-breakpoint
ALTER TABLE `oauth_grants` ADD `prev_refresh_hash` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_revoked` ON `oauth_grants` (`revoked`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_client` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_code` ON `oauth_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_prev_refresh` ON `oauth_grants` (`prev_refresh_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_clients_created` ON `oauth_clients` (`created_at`);

CREATE TABLE `badge` (
	`id` varchar(16) NOT NULL,
	`label` varchar(16) NOT NULL,
	`description` varchar(120) NOT NULL,
	`sort_order` int NOT NULL,
	CONSTRAINT `badge_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_badge` (
	`user_id` varchar(64) NOT NULL,
	`badge_id` varchar(16) NOT NULL,
	`granted_by` varchar(64),
	`granted_at` datetime(3) NOT NULL,
	CONSTRAINT `user_badge_user_id_badge_id_pk` PRIMARY KEY(`user_id`,`badge_id`)
);
--> statement-breakpoint
ALTER TABLE `user_badge` ADD CONSTRAINT `user_badge_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_badge` ADD CONSTRAINT `user_badge_badge_id_badge_id_fk` FOREIGN KEY (`badge_id`) REFERENCES `badge`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_badge` ADD CONSTRAINT `user_badge_granted_by_user_id_fk` FOREIGN KEY (`granted_by`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_badge_badge_idx` ON `user_badge` (`badge_id`);
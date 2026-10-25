CREATE TABLE `user_registration` (
	`seq` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` varchar(64) NOT NULL,
	CONSTRAINT `user_registration_seq` PRIMARY KEY(`seq`),
	CONSTRAINT `user_registration_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `user` ADD `equipped_badge` varchar(16);--> statement-breakpoint
ALTER TABLE `user_registration` ADD CONSTRAINT `user_registration_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user` ADD CONSTRAINT `user_equipped_badge_badge_id_fk` FOREIGN KEY (`equipped_badge`) REFERENCES `badge`(`id`) ON DELETE set null ON UPDATE no action;
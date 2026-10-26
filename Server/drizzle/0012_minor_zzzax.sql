CREATE TABLE `status_event` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`environment` varchar(24) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`title` varchar(120) NOT NULL,
	`body` text NOT NULL,
	`status` varchar(16) NOT NULL,
	`components` text NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`planned_end_at` datetime(3),
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `status_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `status_sample` (
	`environment` varchar(24) NOT NULL,
	`component_id` varchar(24) NOT NULL,
	`bucket` bigint unsigned NOT NULL,
	`total` int NOT NULL,
	`operational` int NOT NULL,
	`degraded` int NOT NULL,
	`unknown` int NOT NULL,
	`latency_sum` bigint unsigned NOT NULL,
	`latency_count` int NOT NULL,
	CONSTRAINT `status_sample_environment_component_id_bucket_pk` PRIMARY KEY(`environment`,`component_id`,`bucket`)
);
--> statement-breakpoint
CREATE TABLE `status_daily__v2` (
	`environment` varchar(24) DEFAULT 'production' NOT NULL,
	`component_id` varchar(24) NOT NULL,
	`day` varchar(10) NOT NULL,
	`total` int NOT NULL,
	`operational` int NOT NULL,
	`degraded` int NOT NULL,
	`unknown` int NOT NULL,
	CONSTRAINT `status_daily_environment_component_id_day_pk` PRIMARY KEY(`environment`,`component_id`,`day`)
);--> statement-breakpoint
INSERT INTO `status_daily__v2` (`environment`,`component_id`,`day`,`total`,`operational`,`degraded`,`unknown`) SELECT 'production',`component_id`,`day`,`total`,`operational`,`degraded`,`unknown` FROM `status_daily`;--> statement-breakpoint
RENAME TABLE `status_daily` TO `status_daily__legacy`,`status_daily__v2` TO `status_daily`;--> statement-breakpoint
DROP TABLE `status_daily__legacy`;--> statement-breakpoint
CREATE INDEX `status_daily_day_idx` ON `status_daily` (`day`);--> statement-breakpoint
CREATE INDEX `status_event_env_idx` ON `status_event` (`environment`,`started_at`);--> statement-breakpoint
CREATE INDEX `status_sample_bucket_idx` ON `status_sample` (`bucket`);

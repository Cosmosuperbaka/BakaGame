CREATE TABLE `client_channel_device` (
	`client_id` varchar(64) NOT NULL,
	`client_type` varchar(16) NOT NULL,
	`platform` varchar(32) NOT NULL,
	`key_algorithm` varchar(16) NOT NULL,
	`public_key` text NOT NULL,
	`key_protection` varchar(16) NOT NULL,
	`registered_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	CONSTRAINT `client_channel_device_client_id` PRIMARY KEY(`client_id`)
);

variable "name_prefix" {
  type = string
}

variable "alerts_kms_key_arn" {
  type = string
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffixes" {
  type = map(string)
}

variable "latency_p95_seconds" {
  type    = number
  default = 1.5
}

variable "postgres_instance_id" {
  type = string
}

variable "postgres_free_storage_bytes_threshold" {
  type    = number
  default = 21474836480
}

variable "redis_replication_group_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "critical_services" {
  type = map(number)
}

variable "cloudtrail_log_group_name" {
  type = string
}

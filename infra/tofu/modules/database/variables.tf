variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  type = list(string)
}

variable "client_security_group_ids" {
  type = list(string)
}

variable "database_kms_key_arn" {
  type = string
}

variable "cache_kms_key_arn" {
  type = string
}

variable "secrets_kms_key_arn" {
  type = string
}

variable "redis_auth_secret_id" {
  type = string
}

variable "postgres_engine_version" {
  type    = string
  default = "18"
}

variable "postgres_instance_class" {
  type = string
}

variable "postgres_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "postgres_max_allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "multi_az" {
  type    = bool
  default = true
}

variable "backup_retention_days" {
  type    = number
  default = 35
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 7 and 35 so point-in-time recovery stays available."
  }
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "slow_query_ms" {
  type    = number
  default = 500
}

variable "cache_engine_version" {
  type    = string
  default = "8.1"
}

variable "cache_node_type" {
  type = string
}

variable "cache_replicas" {
  type    = number
  default = 1
}

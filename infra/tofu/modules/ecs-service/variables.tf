variable "name_prefix" {
  type = string
}

variable "service" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by digest (<repository>@sha256:<digest>)."
  }
}

variable "repository_arn" {
  type = string
}

variable "command" {
  type    = list(string)
  default = null
}

variable "container_user" {
  type    = string
  default = null
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "ephemeral_storage_gib" {
  type    = number
  default = 21
}

variable "port_mappings" {
  type = list(object({
    name         = string
    port         = number
    app_protocol = optional(string)
  }))
  default = []
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "secrets" {
  type    = map(string)
  default = {}
}

variable "task_policy_json" {
  type    = string
  default = null
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "desired_count" {
  type = number
}

variable "autoscaling" {
  type = object({
    min                       = number
    max                       = number
    cpu_target                = optional(number, 60)
    scale_in_cooldown_seconds = optional(number, 300)
  })
  default = null
}

variable "load_balancers" {
  type = list(object({
    target_group_arn = string
    container_port   = number
  }))
  default = []
}

variable "service_discovery_namespace_id" {
  type    = string
  default = null
}

variable "service_discovery_name" {
  type    = string
  default = null
}

variable "health_check_command" {
  type    = list(string)
  default = null
}

variable "health_check_start_period_seconds" {
  type    = number
  default = 60
}

variable "stop_timeout_seconds" {
  type    = number
  default = 30
  validation {
    condition     = var.stop_timeout_seconds >= 2 && var.stop_timeout_seconds <= 120
    error_message = "stop_timeout_seconds must be between 2 and 120 on Fargate."
  }
}

variable "deployment_minimum_healthy_percent" {
  type    = number
  default = 100
}

variable "deployment_maximum_percent" {
  type    = number
  default = 200
}

variable "readonly_root_filesystem" {
  type    = bool
  default = false
}

variable "enable_execute_command" {
  type    = bool
  default = false
}

variable "efs_volume" {
  type = object({
    file_system_id  = string
    access_point_id = string
    container_path  = string
  })
  default = null
}

variable "logs_kms_key_arn" {
  type = string
}

variable "secrets_kms_key_arn" {
  type = string
}

variable "ecr_kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

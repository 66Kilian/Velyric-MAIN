variable "environment" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr_block" {
  type = string
}

variable "app_subnet_ids" {
  type = list(string)
}

variable "data_subnet_ids" {
  type = list(string)
}

variable "client_security_group_ids" {
  type = list(string)
}

variable "cluster_arn" {
  type = string
}

variable "service_discovery_namespace_id" {
  type = string
}

variable "internal_domain" {
  type = string
}

variable "image" {
  type = string
}

variable "repository_arn" {
  type = string
}

variable "node_count" {
  type    = number
  default = 3
  validation {
    condition     = contains([1, 3, 5], var.node_count)
    error_message = "node_count must be 1, 3 or 5 for a JetStream quorum."
  }
}

variable "cpu" {
  type    = number
  default = 1024
}

variable "memory" {
  type    = number
  default = 2048
}

variable "max_file_store_bytes" {
  type    = number
  default = 214748364800
}

variable "max_memory_store_bytes" {
  type    = number
  default = 1073741824
}

variable "efs_kms_key_arn" {
  type = string
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

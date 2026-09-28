variable "environment" {
  type = string
}

variable "repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "repository must be <owner>/<name>."
  }
}

variable "github_environment" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "repository_arns" {
  type = list(string)
}

variable "ecr_kms_key_arn" {
  type = string
}

variable "create_oidc_provider" {
  type    = bool
  default = true
}

variable "create_image_publisher" {
  type    = bool
  default = false
}

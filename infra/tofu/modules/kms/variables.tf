variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "purposes" {
  type = list(string)
  default = [
    "database",
    "cache",
    "secrets",
    "tenant-secrets",
    "logs",
    "alerts",
    "ecr",
    "efs",
    "s3-knowledge",
    "s3-artifacts",
    "s3-recordings",
    "s3-exports",
    "s3-evidence",
    "s3-transient",
  ]
}

variable "deletion_window_in_days" {
  type    = number
  default = 30
}

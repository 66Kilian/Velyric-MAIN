variable "bucket_prefix" {
  type = string
  validation {
    condition     = can(regex("^velyric-[a-z]+-[a-z]{2}-[a-z]+-[0-9]$", var.bucket_prefix))
    error_message = "bucket_prefix must follow velyric-<env>-<aws_region>."
  }
}

variable "kms_key_arns" {
  type = map(string)
}

variable "upload_allowed_origins" {
  type = list(string)
}

variable "evidence_retention_days" {
  type    = number
  default = 730
}

variable "export_retention_days" {
  type    = number
  default = 7
}

variable "noncurrent_version_days" {
  type    = number
  default = 30
}

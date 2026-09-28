variable "environment" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "recovery_window_in_days" {
  type    = number
  default = 30
}

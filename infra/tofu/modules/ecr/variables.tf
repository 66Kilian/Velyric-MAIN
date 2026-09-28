variable "repositories" {
  type = list(string)
  default = [
    "web",
    "control-api",
    "workflow-worker",
    "connector-worker",
    "db-migrate",
    "voice-runtime",
    "metering-worker",
    "document-worker",
    "eval-runner",
    "nats",
    "otel-collector",
    "clamav",
  ]
}

variable "kms_key_arn" {
  type = string
}

variable "keep_images" {
  type    = number
  default = 200
}

variable "pull_account_ids" {
  type    = list(string)
  default = []
}

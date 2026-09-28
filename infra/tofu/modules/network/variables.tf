variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "cidr_block" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.cidr_block)) && tonumber(split("/", var.cidr_block)[1]) <= 18
    error_message = "cidr_block must be an IPv4 CIDR of /18 or larger."
  }
}

variable "az_count" {
  type    = number
  default = 3
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "interface_endpoints" {
  type = list(string)
  default = [
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "kms",
    "sts",
    "ssm",
    "ssmmessages",
  ]
}

variable "flow_log_retention_days" {
  type    = number
  default = 90
}

variable "logs_kms_key_arn" {
  type = string
}

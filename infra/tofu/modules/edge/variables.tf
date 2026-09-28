variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr_block" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "primary_domain" {
  type = string
}

variable "alternate_domains" {
  type = list(string)
}

variable "allowed_ingress_ipv4_cidrs" {
  type = list(string)
}

variable "allowed_ingress_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "access_logs_bucket" {
  type    = string
  default = null
}

variable "origin_verification_header" {
  type = object({
    name  = string
    value = string
  })
  default   = null
  sensitive = true
}

variable "targets" {
  type = map(object({
    port                         = number
    health_check_path            = string
    health_check_port            = number
    hosts                        = list(string)
    path_patterns                = optional(list(string), [])
    priority                     = number
    deregistration_delay_seconds = optional(number, 30)
  }))
}

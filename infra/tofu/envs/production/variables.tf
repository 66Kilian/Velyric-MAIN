variable "aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12 digit AWS account id."
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "web_domain" {
  type = string
}

variable "api_domain" {
  type = string
}

variable "voice_domain" {
  type = string
}

variable "mail_domain" {
  type = string
}

variable "email_from" {
  type = string
}

variable "edge_ipv4_cidrs" {
  type = list(string)
}

variable "edge_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "origin_verification_secret" {
  type      = string
  sensitive = true
}

variable "github_repository" {
  type = string
}

variable "create_github_oidc_provider" {
  type    = bool
  default = true
}

variable "create_github_image_publisher" {
  type    = bool
  default = false
}

variable "images" {
  type = map(string)
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "terms_version" {
  type = string
}

variable "legal_entity" {
  type = object({
    name          = string
    address       = string
    registration  = string
    tax_number    = string
    privacy_email = string
    sales_email   = string
  })
}

variable "status_page_url" {
  type    = string
  default = ""
}

variable "telnyx_connection_id" {
  type = string
}

variable "telnyx_webhook_public_key" {
  type = string
}

variable "billingo_block_id" {
  type = string
}

variable "temporal_address" {
  type = string
}

variable "metering_token_prices_json" {
  type = string
}

variable "grafana_otlp_endpoint" {
  type = string
}

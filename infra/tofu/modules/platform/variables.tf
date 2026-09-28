variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "cidr_block" {
  type = string
}

variable "az_count" {
  type    = number
  default = 3
}

variable "single_nat_gateway" {
  type    = bool
  default = false
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
  validation {
    condition     = length(var.origin_verification_secret) >= 32
    error_message = "origin_verification_secret must be at least 32 characters."
  }
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
  validation {
    condition = alltrue([
      for name in ["web", "control-api", "voice-runtime", "metering-worker", "workflow-worker", "connector-worker", "document-worker", "eval-runner", "db-migrate", "nats", "clamav", "otel-collector"] :
      can(regex("@sha256:[0-9a-f]{64}$", lookup(var.images, name, "")))
    ])
    error_message = "images must provide a digest-pinned reference for every deploy unit."
  }
}

variable "service_sizes" {
  type = map(object({
    cpu    = number
    memory = number
    min    = number
    max    = number
  }))
}

variable "postgres_instance_class" {
  type = string
}

variable "postgres_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "postgres_max_allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "postgres_multi_az" {
  type    = bool
  default = true
}

variable "cache_node_type" {
  type = string
}

variable "cache_replicas" {
  type    = number
  default = 1
}

variable "nats_node_count" {
  type    = number
  default = 3
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "evidence_retention_days" {
  type    = number
  default = 730
}

variable "audit_trail_retention_days" {
  type    = number
  default = 2555
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "terms_version" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.terms_version))
    error_message = "terms_version must be a YYYY-MM-DD date."
  }
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

variable "temporal_namespace" {
  type = string
}

variable "metering_token_prices_json" {
  type = string
  validation {
    condition     = can(jsondecode(var.metering_token_prices_json))
    error_message = "metering_token_prices_json must be valid JSON."
  }
}

variable "voice_drain_timeout_seconds" {
  type    = number
  default = 1800
}

variable "service_key_generation" {
  type    = number
  default = 1
}

variable "grafana_otlp_endpoint" {
  type = string
  validation {
    condition     = startswith(var.grafana_otlp_endpoint, "https://")
    error_message = "grafana_otlp_endpoint must be an https URL in an EU region."
  }
}

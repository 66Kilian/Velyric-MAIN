terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.1"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = {
      Project     = "velyric"
      Environment = "staging"
      ManagedBy   = "opentofu"
    }
  }
}

module "platform" {
  source = "../../modules/platform"

  environment        = "staging"
  region             = var.region
  cidr_block         = "10.40.0.0/16"
  az_count           = 3
  single_nat_gateway = true

  web_domain                    = var.web_domain
  api_domain                    = var.api_domain
  voice_domain                  = var.voice_domain
  mail_domain                   = var.mail_domain
  email_from                    = var.email_from
  edge_ipv4_cidrs               = var.edge_ipv4_cidrs
  edge_ipv6_cidrs               = var.edge_ipv6_cidrs
  origin_verification_secret    = var.origin_verification_secret
  github_repository             = var.github_repository
  create_github_oidc_provider   = var.create_github_oidc_provider
  create_github_image_publisher = var.create_github_image_publisher
  images                        = var.images
  alert_emails                  = var.alert_emails

  postgres_instance_class       = "db.m7g.large"
  postgres_allocated_storage_gb = 50
  postgres_multi_az             = false
  cache_node_type               = "cache.m7g.large"
  cache_replicas                = 0
  nats_node_count               = 3
  deletion_protection           = false
  evidence_retention_days       = 30
  audit_trail_retention_days    = 365

  service_sizes = {
    web              = { cpu = 512, memory = 1024, min = 1, max = 3 }
    control-api      = { cpu = 1024, memory = 2048, min = 1, max = 3 }
    voice-runtime    = { cpu = 1024, memory = 2048, min = 1, max = 3 }
    metering-worker  = { cpu = 256, memory = 512, min = 1, max = 2 }
    workflow-worker  = { cpu = 1024, memory = 2048, min = 1, max = 2 }
    connector-worker = { cpu = 512, memory = 1024, min = 1, max = 2 }
    document-worker  = { cpu = 1024, memory = 3072, min = 1, max = 2 }
    eval-runner      = { cpu = 1024, memory = 2048, min = 1, max = 2 }
    clamav           = { cpu = 1024, memory = 4096, min = 1, max = 1 }
    otel-collector   = { cpu = 512, memory = 1024, min = 1, max = 2 }
  }

  terms_version              = var.terms_version
  legal_entity               = var.legal_entity
  status_page_url            = var.status_page_url
  telnyx_connection_id       = var.telnyx_connection_id
  telnyx_webhook_public_key  = var.telnyx_webhook_public_key
  billingo_block_id          = var.billingo_block_id
  temporal_address           = var.temporal_address
  temporal_namespace         = "velyric-staging"
  metering_token_prices_json = var.metering_token_prices_json
  grafana_otlp_endpoint      = var.grafana_otlp_endpoint
}

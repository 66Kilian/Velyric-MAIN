terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

locals {
  services = ["web", "control-api", "voice-runtime", "metering-worker", "workflow-worker", "connector-worker", "document-worker", "eval-runner"]
  static_names = [
    "database/migrator",
    "database/app",
    "database/readonly",
    "database/support",
    "database/metering",
    "redis/auth",
    "service-jwks",
    "session-signing-key",
    "stripe/secret-key",
    "stripe/webhook-signing-secret",
    "billingo/api-key",
    "telnyx/api-key",
    "telnyx/webhook-public-key",
    "twilio/account-sid",
    "twilio/auth-token",
    "openai/admin-key",
    "openai/platform-key",
    "openai/webhook-secret",
    "google/oauth-client",
    "microsoft/oauth-client",
    "ses/configuration",
    "temporal/api-key",
    "grafana/otlp-auth",
    "cursor/signing-key",
    "api-keys/pepper",
    "oauth/state-key",
  ]
  per_service_names = flatten([
    for service in local.services : [
      "service-keys/${service}",
      "nats/${service}",
      "sentry/dsn-${service}",
    ]
  ])
  names = toset(concat(local.static_names, local.per_service_names))
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.names
  name                    = "velyric/${var.environment}/${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags = {
    SecretGroup = split("/", each.key)[0]
  }
}

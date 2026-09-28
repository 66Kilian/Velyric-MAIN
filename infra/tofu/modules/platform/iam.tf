locals {
  service_secret_names = {
    web = []
    control-api = [
      "database/app",
      "redis/auth",
      "cursor/signing-key",
      "api-keys/pepper",
      "oauth/state-key",
      "session-signing-key",
      "stripe/secret-key",
      "stripe/webhook-signing-secret",
      "telnyx/api-key",
      "openai/webhook-secret",
      "twilio/auth-token",
      "service-jwks",
      "service-keys/control-api",
      "google/oauth-client",
      "microsoft/oauth-client",
      "nats/control-api",
    ]
    voice-runtime   = ["redis/auth", "nats/voice-runtime", "openai/webhook-secret", "service-keys/voice-runtime", "openai/platform-key"]
    metering-worker = ["database/metering", "nats/metering-worker"]
    workflow-worker = [
      "database/app",
      "redis/auth",
      "service-jwks",
      "nats/workflow-worker",
      "openai/admin-key",
      "telnyx/api-key",
      "billingo/api-key",
      "stripe/secret-key",
      "temporal/api-key",
      "ses/configuration",
    ]
    connector-worker = ["database/app", "redis/auth", "service-jwks", "nats/connector-worker", "google/oauth-client", "microsoft/oauth-client", "ses/configuration"]
    document-worker  = ["nats/document-worker", "service-keys/document-worker", "openai/platform-key"]
    eval-runner      = ["nats/eval-runner", "service-keys/eval-runner", "openai/platform-key"]
    clamav           = []
    otel-collector   = ["grafana/otlp-auth"]
  }
  tenant_secret_arn = "${local.secret_arn_base}/tenants/*"
  tenant_openai_arn = "${local.secret_arn_base}/tenants/*/openai-service-account-key/*"
  bucket_arns       = module.storage.bucket_arns
}

data "aws_iam_policy_document" "service" {
  for_each = local.services

  dynamic "statement" {
    for_each = length(local.service_secret_names[each.key]) > 0 ? [1] : []
    content {
      sid       = "ReadServiceSecrets"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [for name in local.service_secret_names[each.key] : module.secrets.arns[name]]
    }
  }

  statement {
    sid       = "DecryptServiceSecrets"
    actions   = ["kms:Decrypt"]
    resources = [module.kms.key_arns["secrets"]]
  }

  dynamic "statement" {
    for_each = each.key == "control-api" ? [1] : []
    content {
      sid       = "WriteTenantSecretsWithoutReadBack"
      actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource", "secretsmanager:DescribeSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:DeleteSecret"]
      resources = [local.tenant_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "workflow-worker" ? [1] : []
    content {
      sid       = "RotateTenantOpenAiKeys"
      actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource", "secretsmanager:DescribeSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:DeleteSecret"]
      resources = [local.tenant_openai_arn]
    }
  }

  dynamic "statement" {
    for_each = contains(["control-api", "workflow-worker"], each.key) ? [1] : []
    content {
      sid       = "EncryptTenantSecrets"
      actions   = ["kms:Encrypt", "kms:GenerateDataKey", "kms:Decrypt"]
      resources = [module.kms.key_arns["tenant-secrets"]]
    }
  }

  dynamic "statement" {
    for_each = each.key == "connector-worker" ? [1] : []
    content {
      sid       = "ReadTenantSecrets"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [local.tenant_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = contains(["voice-runtime", "document-worker", "eval-runner"], each.key) ? [1] : []
    content {
      sid       = "ReadTenantOpenAiKeys"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [local.tenant_openai_arn]
    }
  }

  dynamic "statement" {
    for_each = contains(["connector-worker", "voice-runtime", "document-worker", "eval-runner"], each.key) ? [1] : []
    content {
      sid       = "DecryptTenantSecrets"
      actions   = ["kms:Decrypt"]
      resources = [module.kms.key_arns["tenant-secrets"]]
    }
  }

  dynamic "statement" {
    for_each = contains(["control-api", "workflow-worker", "document-worker", "voice-runtime", "eval-runner"], each.key) ? [1] : []
    content {
      sid     = "TenantObjects"
      actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion", "s3:AbortMultipartUpload"]
      resources = flatten([
        for purpose in lookup({
          control-api     = ["knowledge", "artifacts", "recordings", "exports", "evidence", "transient"]
          workflow-worker = ["exports", "evidence", "recordings", "knowledge", "artifacts"]
          document-worker = ["transient", "knowledge"]
          voice-runtime   = ["recordings", "artifacts"]
          eval-runner     = ["artifacts"]
        }, each.key, []) : ["${local.bucket_arns[purpose]}/tenants/*", "${local.bucket_arns[purpose]}/platform/*"]
      ])
    }
  }

  dynamic "statement" {
    for_each = contains(["control-api", "workflow-worker", "document-worker"], each.key) ? [1] : []
    content {
      sid       = "ListTenantPrefixes"
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = values(local.bucket_arns)
    }
  }

  dynamic "statement" {
    for_each = contains(["control-api", "workflow-worker", "document-worker", "voice-runtime", "eval-runner"], each.key) ? [1] : []
    content {
      sid       = "BucketEncryption"
      actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
      resources = [for purpose in ["knowledge", "artifacts", "recordings", "exports", "evidence", "transient"] : module.kms.key_arns["s3-${purpose}"]]
    }
  }

  dynamic "statement" {
    for_each = contains(["workflow-worker", "connector-worker"], each.key) ? [1] : []
    content {
      sid       = "SendTransactionalEmail"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [module.ses.identity_arn, "arn:aws:ses:${var.region}:${local.account_id}:configuration-set/${module.ses.configuration_set_name}"]
    }
  }
}

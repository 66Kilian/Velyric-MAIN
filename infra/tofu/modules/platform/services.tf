locals {
  providers                = ["OPENAI", "TELNYX", "TWILIO", "STRIPE", "BILLINGO", "GOOGLE", "MICROSOFT", "AWS_SES"]
  provider_mode            = var.environment == "production" ? "live" : "sandbox"
  secret                   = { for name, arn in module.secrets.arns : name => arn }
  control_api_internal_url = "http://control-api.${local.internal_domain}:4001"
  common_environment = merge(
    {
      VELYRIC_ENV                         = var.environment
      VELYRIC_AWS_REGION                  = var.region
      VELYRIC_LOG_LEVEL                   = var.log_level
      VELYRIC_OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.${local.internal_domain}:4318"
      VELYRIC_NATS_CA_PEM                 = module.nats.ca_certificate_pem
    },
    { for provider in local.providers : "VELYRIC_PROVIDER_MODE_${provider}" => local.provider_mode },
  )
  node_health = {
    for service, port in {
      web              = "3000/api/healthz/live"
      control-api      = "4001/healthz/live"
      workflow-worker  = "7200/healthz/live"
      connector-worker = "7300/healthz/live"
    } : service => ["CMD", "node", "-e", "fetch('http://127.0.0.1:${port}').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  }
  python_health = {
    for service, port in { document-worker = 7400, eval-runner = 7500 } :
    service => ["CMD", "python", "-c", "import sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${port}/healthz/live',timeout=3).status==200 else 1)"]
  }
  service_common = {
    cluster_arn         = module.cluster.cluster_arn
    subnet_ids          = module.network.app_subnet_ids
    logs_kms_key_arn    = module.kms.key_arns["logs"]
    secrets_kms_key_arn = module.kms.key_arns["secrets"]
    ecr_kms_key_arn     = module.kms.key_arns["ecr"]
    namespace_id        = module.cluster.namespace_id
  }
}

module "web" {
  source                            = "../ecs-service"
  name_prefix                       = local.name_prefix
  service                           = "web"
  cluster_arn                       = local.service_common.cluster_arn
  image                             = var.images["web"]
  repository_arn                    = module.ecr.repository_arns["web"]
  cpu                               = var.service_sizes["web"].cpu
  memory                            = var.service_sizes["web"].memory
  desired_count                     = var.service_sizes["web"].min
  autoscaling                       = { min = var.service_sizes["web"].min, max = var.service_sizes["web"].max }
  subnet_ids                        = local.service_common.subnet_ids
  security_group_id                 = aws_security_group.service["web"].id
  task_policy_json                  = data.aws_iam_policy_document.service["web"].json
  logs_kms_key_arn                  = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn               = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                   = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id    = local.service_common.namespace_id
  health_check_command              = local.node_health["web"]
  port_mappings                     = [{ name = "http", port = 3000, app_protocol = "http" }]
  load_balancers                    = [{ target_group_arn = module.edge.target_group_arns["web"], container_port = 3000 }]
  health_check_start_period_seconds = 60
  environment_variables = merge(local.common_environment, {
    PORT                                  = "3000"
    HOSTNAME                              = "0.0.0.0"
    VELYRIC_PUBLIC_WEB_ORIGIN             = local.web_origin
    VELYRIC_CONTROL_API_URL               = "http://control-api.${local.internal_domain}:4000"
    VELYRIC_TERMS_VERSION                 = var.terms_version
    VELYRIC_LEGAL_ENTITY_NAME             = var.legal_entity.name
    VELYRIC_LEGAL_ENTITY_ADDRESS          = var.legal_entity.address
    VELYRIC_LEGAL_ENTITY_REGISTRATION     = var.legal_entity.registration
    VELYRIC_LEGAL_ENTITY_TAX_NUMBER       = var.legal_entity.tax_number
    VELYRIC_PRIVACY_CONTACT_EMAIL         = var.legal_entity.privacy_email
    VELYRIC_SALES_CONTACT_EMAIL           = var.legal_entity.sales_email
    VELYRIC_STATUS_PAGE_URL               = var.status_page_url
  })
}

module "control_api" {
  source                            = "../ecs-service"
  name_prefix                       = local.name_prefix
  service                           = "control-api"
  cluster_arn                       = local.service_common.cluster_arn
  image                             = var.images["control-api"]
  repository_arn                    = module.ecr.repository_arns["control-api"]
  cpu                               = var.service_sizes["control-api"].cpu
  memory                            = var.service_sizes["control-api"].memory
  desired_count                     = var.service_sizes["control-api"].min
  autoscaling                       = { min = var.service_sizes["control-api"].min, max = var.service_sizes["control-api"].max }
  subnet_ids                        = local.service_common.subnet_ids
  security_group_id                 = aws_security_group.service["control-api"].id
  task_policy_json                  = data.aws_iam_policy_document.service["control-api"].json
  logs_kms_key_arn                  = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn               = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                   = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id    = local.service_common.namespace_id
  health_check_command              = local.node_health["control-api"]
  load_balancers                    = [{ target_group_arn = module.edge.target_group_arns["api"], container_port = 4000 }]
  health_check_start_period_seconds = 90
  port_mappings = [
    { name = "public", port = 4000, app_protocol = "http" },
    { name = "internal", port = 4001, app_protocol = "http" },
  ]
  environment_variables = merge(local.common_environment, {
    CONTROL_API_HOST                              = "0.0.0.0"
    CONTROL_API_PUBLIC_PORT                       = "4000"
    CONTROL_API_INTERNAL_PORT                     = "4001"
    CONTROL_API_CORS_ALLOWED_ORIGINS              = local.web_origin
    CONTROL_API_SERVICE_KEY_ID                    = local.service_key_ids["control-api"]
    VELYRIC_S3_BUCKET_PREFIX                      = local.bucket_prefix
    VELYRIC_TERMS_VERSION                         = var.terms_version
    VELYRIC_NATS_URL                              = module.nats.client_url
    VELYRIC_PUBLIC_WEB_ORIGIN                     = local.web_origin
    VELYRIC_PUBLIC_API_ORIGIN                     = local.api_origin
    VELYRIC_TELNYX_WEBHOOK_PUBLIC_KEY             = var.telnyx_webhook_public_key
    VELYRIC_DATABASE_URL_SECRET_ARN               = local.secret["database/app"]
    VELYRIC_REDIS_URL_SECRET_ARN                  = local.secret["redis/auth"]
    VELYRIC_NATS_CREDS_SECRET_ARN                 = local.secret["nats/control-api"]
    CONTROL_API_CURSOR_KEY_SECRET_ARN             = local.secret["cursor/signing-key"]
    CONTROL_API_API_KEY_PEPPER_SECRET_ARN         = local.secret["api-keys/pepper"]
    CONTROL_API_STATE_KEY_SECRET_ARN              = local.secret["oauth/state-key"]
    VELYRIC_SESSION_SIGNING_KEY_SECRET_ARN        = local.secret["session-signing-key"]
    VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN          = local.secret["stripe/secret-key"]
    VELYRIC_STRIPE_WEBHOOK_SIGNING_SECRET_ARN     = local.secret["stripe/webhook-signing-secret"]
    VELYRIC_TELNYX_API_KEY_SECRET_ARN             = local.secret["telnyx/api-key"]
    VELYRIC_OPENAI_WEBHOOK_SECRET_ARN             = local.secret["openai/webhook-secret"]
    VELYRIC_TWILIO_AUTH_TOKEN_SECRET_ARN          = local.secret["twilio/auth-token"]
    VELYRIC_SERVICE_JWKS_SECRET_ARN               = local.secret["service-jwks"]
    VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN        = local.secret["service-keys/control-api"]
    CONTROL_API_GOOGLE_OAUTH_CLIENT_SECRET_ARN    = local.secret["google/oauth-client"]
    CONTROL_API_MICROSOFT_OAUTH_CLIENT_SECRET_ARN = local.secret["microsoft/oauth-client"]
  })
}

module "voice_runtime" {
  source                             = "../ecs-service"
  name_prefix                        = local.name_prefix
  service                            = "voice-runtime"
  cluster_arn                        = local.service_common.cluster_arn
  image                              = var.images["voice-runtime"]
  repository_arn                     = module.ecr.repository_arns["voice-runtime"]
  cpu                                = var.service_sizes["voice-runtime"].cpu
  memory                             = var.service_sizes["voice-runtime"].memory
  desired_count                      = var.service_sizes["voice-runtime"].min
  autoscaling                        = { min = var.service_sizes["voice-runtime"].min, max = var.service_sizes["voice-runtime"].max, cpu_target = 50, scale_in_cooldown_seconds = 1800 }
  subnet_ids                         = local.service_common.subnet_ids
  security_group_id                  = aws_security_group.service["voice-runtime"].id
  task_policy_json                   = data.aws_iam_policy_document.service["voice-runtime"].json
  logs_kms_key_arn                   = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn                = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                    = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id     = local.service_common.namespace_id
  load_balancers                     = [{ target_group_arn = module.edge.target_group_arns["voice"], container_port = 7000 }]
  stop_timeout_seconds               = 120
  readonly_root_filesystem           = true
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  port_mappings = [
    { name = "public", port = 7000, app_protocol = "http" },
    { name = "admin", port = 7001, app_protocol = "http" },
  ]
  secrets = {
    VELYRIC_REDIS_URL = local.secret["redis/auth"]
  }
  environment_variables = merge(local.common_environment, {
    VOICE_RUNTIME_HOST                      = "0.0.0.0"
    VOICE_RUNTIME_PUBLIC_PORT               = "7000"
    VOICE_RUNTIME_ADMIN_PORT                = "7001"
    VOICE_RUNTIME_DRAIN_TIMEOUT_SECONDS     = tostring(var.voice_drain_timeout_seconds)
    VOICE_RUNTIME_SERVICE_KEY_ID            = local.service_key_ids["voice-runtime"]
    VELYRIC_NATS_URL                        = module.nats.client_url
    VELYRIC_CONTROL_API_INTERNAL_URL        = local.control_api_internal_url
    VELYRIC_SERVICE_JWKS_URL                = "${local.control_api_internal_url}/internal/v1/.well-known/jwks.json"
    VELYRIC_NATS_CREDS_SECRET_ARN           = local.secret["nats/voice-runtime"]
    VELYRIC_OPENAI_WEBHOOK_SECRET_ARN       = local.secret["openai/webhook-secret"]
    VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN  = local.secret["service-keys/voice-runtime"]
    VOICE_RUNTIME_OPENAI_API_KEY_SECRET_ARN = local.secret["openai/platform-key"]
  })
}

module "metering_worker" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "metering-worker"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["metering-worker"]
  repository_arn                 = module.ecr.repository_arns["metering-worker"]
  cpu                            = var.service_sizes["metering-worker"].cpu
  memory                         = var.service_sizes["metering-worker"].memory
  desired_count                  = var.service_sizes["metering-worker"].min
  autoscaling                    = { min = var.service_sizes["metering-worker"].min, max = var.service_sizes["metering-worker"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["metering-worker"].id
  task_policy_json               = data.aws_iam_policy_document.service["metering-worker"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  readonly_root_filesystem       = true
  port_mappings                  = [{ name = "health", port = 7100, app_protocol = "http" }]
  environment_variables = merge(local.common_environment, {
    METERING_WORKER_HOST            = "0.0.0.0"
    METERING_WORKER_PORT            = "7100"
    METERING_WORKER_STREAM_REPLICAS = tostring(var.nats_node_count)
    METERING_WORKER_TOKEN_PRICES    = var.metering_token_prices_json
    VELYRIC_NATS_URL                = module.nats.client_url
    VELYRIC_DATABASE_URL_SECRET_ARN = local.secret["database/metering"]
    VELYRIC_NATS_CREDS_SECRET_ARN   = local.secret["nats/metering-worker"]
  })
}

module "workflow_worker" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "workflow-worker"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["workflow-worker"]
  repository_arn                 = module.ecr.repository_arns["workflow-worker"]
  cpu                            = var.service_sizes["workflow-worker"].cpu
  memory                         = var.service_sizes["workflow-worker"].memory
  desired_count                  = var.service_sizes["workflow-worker"].min
  autoscaling                    = { min = var.service_sizes["workflow-worker"].min, max = var.service_sizes["workflow-worker"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["workflow-worker"].id
  task_policy_json               = data.aws_iam_policy_document.service["workflow-worker"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  health_check_command           = local.node_health["workflow-worker"]
  stop_timeout_seconds           = 60
  port_mappings                  = [{ name = "health", port = 7200, app_protocol = "http" }]
  secrets = {
    VELYRIC_REDIS_URL    = local.secret["redis/auth"]
    VELYRIC_SERVICE_JWKS = local.secret["service-jwks"]
  }
  environment_variables = merge(local.common_environment, {
    WORKFLOW_WORKER_HOST                        = "0.0.0.0"
    WORKFLOW_WORKER_PORT                        = "7200"
    WORKFLOW_WORKER_STREAM_REPLICAS             = tostring(var.nats_node_count)
    WORKFLOW_WORKER_TELNYX_CONNECTION_ID        = var.telnyx_connection_id
    WORKFLOW_WORKER_BILLINGO_BLOCK_ID           = var.billingo_block_id
    WORKFLOW_WORKER_EMAIL_FROM                  = var.email_from
    WORKFLOW_WORKER_SES_CONFIGURATION_SET       = module.ses.configuration_set_name
    VELYRIC_PUBLIC_WEB_ORIGIN                   = local.web_origin
    VELYRIC_NATS_URL                            = module.nats.client_url
    VELYRIC_TEMPORAL_ADDRESS                    = var.temporal_address
    VELYRIC_TEMPORAL_NAMESPACE                  = var.temporal_namespace
    VELYRIC_TEMPORAL_TLS                        = "true"
    VELYRIC_TEMPORAL_API_KEY_SECRET_ARN         = local.secret["temporal/api-key"]
    VELYRIC_DATABASE_URL_SECRET_ARN             = local.secret["database/app"]
    VELYRIC_NATS_CREDS_SECRET_ARN               = local.secret["nats/workflow-worker"]
    WORKFLOW_WORKER_OPENAI_ADMIN_KEY_SECRET_ARN = local.secret["openai/admin-key"]
    VELYRIC_TELNYX_API_KEY_SECRET_ARN           = local.secret["telnyx/api-key"]
    VELYRIC_BILLINGO_API_KEY_SECRET_ARN         = local.secret["billingo/api-key"]
    VELYRIC_STRIPE_SECRET_KEY_SECRET_ARN        = local.secret["stripe/secret-key"]
  })
}

module "connector_worker" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "connector-worker"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["connector-worker"]
  repository_arn                 = module.ecr.repository_arns["connector-worker"]
  cpu                            = var.service_sizes["connector-worker"].cpu
  memory                         = var.service_sizes["connector-worker"].memory
  desired_count                  = var.service_sizes["connector-worker"].min
  autoscaling                    = { min = var.service_sizes["connector-worker"].min, max = var.service_sizes["connector-worker"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["connector-worker"].id
  task_policy_json               = data.aws_iam_policy_document.service["connector-worker"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  health_check_command           = local.node_health["connector-worker"]
  port_mappings                  = [{ name = "health", port = 7300, app_protocol = "http" }]
  secrets = {
    VELYRIC_REDIS_URL    = local.secret["redis/auth"]
    VELYRIC_SERVICE_JWKS = local.secret["service-jwks"]
  }
  environment_variables = merge(local.common_environment, {
    CONNECTOR_WORKER_HOST                              = "0.0.0.0"
    CONNECTOR_WORKER_PORT                              = "7300"
    VELYRIC_NATS_URL                                   = module.nats.client_url
    VELYRIC_DATABASE_URL_SECRET_ARN                    = local.secret["database/app"]
    VELYRIC_NATS_CREDS_SECRET_ARN                      = local.secret["nats/connector-worker"]
    CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET_ARN    = local.secret["google/oauth-client"]
    CONNECTOR_WORKER_MICROSOFT_OAUTH_CLIENT_SECRET_ARN = local.secret["microsoft/oauth-client"]
  })
}

module "document_worker" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "document-worker"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["document-worker"]
  repository_arn                 = module.ecr.repository_arns["document-worker"]
  cpu                            = var.service_sizes["document-worker"].cpu
  memory                         = var.service_sizes["document-worker"].memory
  desired_count                  = var.service_sizes["document-worker"].min
  autoscaling                    = { min = var.service_sizes["document-worker"].min, max = var.service_sizes["document-worker"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["document-worker"].id
  task_policy_json               = data.aws_iam_policy_document.service["document-worker"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  health_check_command           = local.python_health["document-worker"]
  ephemeral_storage_gib          = 50
  port_mappings                  = [{ name = "health", port = 7400, app_protocol = "http" }]
  environment_variables = merge(local.common_environment, {
    DOCUMENT_WORKER_HOST                   = "0.0.0.0"
    DOCUMENT_WORKER_PORT                   = "7400"
    DOCUMENT_WORKER_OCR_ENABLED            = "true"
    DOCUMENT_WORKER_CLAMD_HOST             = "clamav.${local.internal_domain}"
    DOCUMENT_WORKER_CLAMD_PORT             = "3310"
    DOCUMENT_WORKER_STREAM_REPLICAS        = tostring(var.nats_node_count)
    DOCUMENT_WORKER_SERVICE_KEY_ID         = local.service_key_ids["document-worker"]
    VELYRIC_CONTROL_API_INTERNAL_URL       = local.control_api_internal_url
    VELYRIC_NATS_URL                       = module.nats.client_url
    VELYRIC_NATS_CREDS_SECRET_ARN          = local.secret["nats/document-worker"]
    VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN = local.secret["service-keys/document-worker"]
  })
}

module "eval_runner" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "eval-runner"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["eval-runner"]
  repository_arn                 = module.ecr.repository_arns["eval-runner"]
  cpu                            = var.service_sizes["eval-runner"].cpu
  memory                         = var.service_sizes["eval-runner"].memory
  desired_count                  = var.service_sizes["eval-runner"].min
  autoscaling                    = { min = var.service_sizes["eval-runner"].min, max = var.service_sizes["eval-runner"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["eval-runner"].id
  task_policy_json               = data.aws_iam_policy_document.service["eval-runner"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  health_check_command           = local.python_health["eval-runner"]
  port_mappings                  = [{ name = "health", port = 7500, app_protocol = "http" }]
  environment_variables = merge(local.common_environment, {
    EVAL_RUNNER_HOST                       = "0.0.0.0"
    EVAL_RUNNER_PORT                       = "7500"
    EVAL_RUNNER_STREAM_REPLICAS            = tostring(var.nats_node_count)
    EVAL_RUNNER_SERVICE_KEY_ID             = local.service_key_ids["eval-runner"]
    VELYRIC_CONTROL_API_INTERNAL_URL       = local.control_api_internal_url
    VELYRIC_NATS_URL                       = module.nats.client_url
    VELYRIC_NATS_CREDS_SECRET_ARN          = local.secret["nats/eval-runner"]
    VELYRIC_SERVICE_SIGNING_KEY_SECRET_ARN = local.secret["service-keys/eval-runner"]
  })
}

module "clamav" {
  source                            = "../ecs-service"
  name_prefix                       = local.name_prefix
  service                           = "clamav"
  cluster_arn                       = local.service_common.cluster_arn
  image                             = var.images["clamav"]
  repository_arn                    = module.ecr.repository_arns["clamav"]
  cpu                               = var.service_sizes["clamav"].cpu
  memory                            = var.service_sizes["clamav"].memory
  desired_count                     = var.service_sizes["clamav"].min
  autoscaling                       = { min = var.service_sizes["clamav"].min, max = var.service_sizes["clamav"].max }
  subnet_ids                        = local.service_common.subnet_ids
  security_group_id                 = aws_security_group.service["clamav"].id
  logs_kms_key_arn                  = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn               = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                   = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id    = local.service_common.namespace_id
  health_check_command              = ["CMD-SHELL", "clamdcheck.sh || exit 1"]
  health_check_start_period_seconds = 300
  port_mappings                     = [{ name = "clamd", port = 3310 }]
}

module "otel_collector" {
  source                         = "../ecs-service"
  name_prefix                    = local.name_prefix
  service                        = "otel-collector"
  cluster_arn                    = local.service_common.cluster_arn
  image                          = var.images["otel-collector"]
  repository_arn                 = module.ecr.repository_arns["otel-collector"]
  cpu                            = var.service_sizes["otel-collector"].cpu
  memory                         = var.service_sizes["otel-collector"].memory
  desired_count                  = var.service_sizes["otel-collector"].min
  autoscaling                    = { min = var.service_sizes["otel-collector"].min, max = var.service_sizes["otel-collector"].max }
  subnet_ids                     = local.service_common.subnet_ids
  security_group_id              = aws_security_group.service["otel-collector"].id
  task_policy_json               = data.aws_iam_policy_document.service["otel-collector"].json
  logs_kms_key_arn               = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn            = local.service_common.secrets_kms_key_arn
  ecr_kms_key_arn                = local.service_common.ecr_kms_key_arn
  service_discovery_namespace_id = local.service_common.namespace_id
  command                        = ["--config=env:OTEL_COLLECTOR_CONFIG"]
  readonly_root_filesystem       = true
  port_mappings = [
    { name = "otlp-grpc", port = 4317, app_protocol = "grpc" },
    { name = "otlp-http", port = 4318, app_protocol = "http" },
  ]
  secrets = {
    GRAFANA_OTLP_AUTH = local.secret["grafana/otlp-auth"]
  }
  environment_variables = {
    OTEL_COLLECTOR_CONFIG = file("${path.module}/../../../observability/otel-collector.aws.yaml")
    GRAFANA_OTLP_ENDPOINT = var.grafana_otlp_endpoint
  }
}

resource "aws_ecs_task_definition" "db_migrate" {
  family                   = "${local.name_prefix}-db-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.db_migrate_execution.arn
  task_role_arn            = aws_iam_role.db_migrate_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    {
      name      = "db-migrate"
      image     = var.images["db-migrate"]
      essential = true
      command   = ["migrate"]
      environment = [
        { name = "VELYRIC_ENV", value = var.environment },
        { name = "VELYRIC_MIGRATION_ACTOR", value = "velyric-${var.environment}-deploy" },
      ]
      secrets = [
        { name = "VELYRIC_DATABASE_MIGRATOR_URL", valueFrom = local.secret["database/migrator"] },
      ]
      linuxParameters = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.db_migrate.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "db-migrate"
        }
      }
    }
  ])
}

resource "aws_cloudwatch_log_group" "db_migrate" {
  name              = "/velyric/${local.name_prefix}/db-migrate"
  retention_in_days = 365
  kms_key_id        = module.kms.key_arns["logs"]
}

resource "aws_security_group" "db_migrate" {
  name        = "${local.name_prefix}-db-migrate"
  vpc_id      = module.network.vpc_id
  description = "velyric ${var.environment} migration task"
}

resource "aws_vpc_security_group_egress_rule" "db_migrate" {
  security_group_id = aws_security_group.db_migrate.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_migrate" {
  security_group_id            = module.database.postgres_security_group_id
  referenced_security_group_id = aws_security_group.db_migrate.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "db_migrate_execution" {
  name               = "${local.name_prefix}-db-migrate-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "db_migrate_task" {
  name               = "${local.name_prefix}-db-migrate"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "db_migrate_execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [module.ecr.repository_arns["db-migrate"]]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.db_migrate.arn}:*"]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.secret["database/migrator"]]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [module.kms.key_arns["secrets"], module.kms.key_arns["ecr"]]
  }
}

resource "aws_iam_role_policy" "db_migrate_execution" {
  role   = aws_iam_role.db_migrate_execution.id
  policy = data.aws_iam_policy_document.db_migrate_execution.json
}

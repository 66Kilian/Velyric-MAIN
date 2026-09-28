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
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix     = "velyric-${var.environment}"
  bucket_prefix   = "velyric-${var.environment}-${var.region}"
  internal_domain = "velyric-${var.environment}.internal"
  account_id      = data.aws_caller_identity.current.account_id
  web_origin      = "https://${var.web_domain}"
  api_origin      = "https://${var.api_domain}"
  secret_arn_base = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:velyric/${var.environment}"
  services = toset([
    "web",
    "control-api",
    "voice-runtime",
    "metering-worker",
    "workflow-worker",
    "connector-worker",
    "document-worker",
    "eval-runner",
    "clamav",
    "otel-collector",
  ])
}

module "kms" {
  source      = "../kms"
  environment = var.environment
  region      = var.region
}

module "network" {
  source             = "../network"
  name               = local.name_prefix
  region             = var.region
  cidr_block         = var.cidr_block
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  logs_kms_key_arn   = module.kms.key_arns["logs"]
}

module "secrets" {
  source      = "../secrets"
  environment = var.environment
  kms_key_arn = module.kms.key_arns["secrets"]
}

module "storage" {
  source                  = "../storage"
  bucket_prefix           = local.bucket_prefix
  kms_key_arns            = module.kms.key_arns
  upload_allowed_origins  = [local.web_origin]
  evidence_retention_days = var.evidence_retention_days
}

module "ecr" {
  source      = "../ecr"
  kms_key_arn = module.kms.key_arns["ecr"]
}

module "cluster" {
  source           = "../ecs-cluster"
  name             = local.name_prefix
  vpc_id           = module.network.vpc_id
  internal_domain  = local.internal_domain
  logs_kms_key_arn = module.kms.key_arns["logs"]
}

module "database" {
  source                            = "../database"
  name                              = local.name_prefix
  vpc_id                            = module.network.vpc_id
  data_subnet_ids                   = module.network.data_subnet_ids
  client_security_group_ids         = [for service in ["control-api", "metering-worker", "workflow-worker", "connector-worker", "voice-runtime"] : aws_security_group.service[service].id]
  database_kms_key_arn              = module.kms.key_arns["database"]
  cache_kms_key_arn                 = module.kms.key_arns["cache"]
  secrets_kms_key_arn               = module.kms.key_arns["secrets"]
  redis_auth_secret_id              = module.secrets.ids["redis/auth"]
  postgres_instance_class           = var.postgres_instance_class
  postgres_allocated_storage_gb     = var.postgres_allocated_storage_gb
  postgres_max_allocated_storage_gb = var.postgres_max_allocated_storage_gb
  multi_az                          = var.postgres_multi_az
  deletion_protection               = var.deletion_protection
  cache_node_type                   = var.cache_node_type
  cache_replicas                    = var.cache_replicas
}

module "nats" {
  source                         = "../nats"
  environment                    = var.environment
  name_prefix                    = local.name_prefix
  vpc_id                         = module.network.vpc_id
  vpc_cidr_block                 = module.network.vpc_cidr_block
  app_subnet_ids                 = module.network.app_subnet_ids
  data_subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids      = [for service in ["control-api", "metering-worker", "workflow-worker", "connector-worker", "voice-runtime", "document-worker", "eval-runner"] : aws_security_group.service[service].id]
  cluster_arn                    = module.cluster.cluster_arn
  service_discovery_namespace_id = module.cluster.namespace_id
  internal_domain                = local.internal_domain
  image                          = var.images["nats"]
  repository_arn                 = module.ecr.repository_arns["nats"]
  node_count                     = var.nats_node_count
  efs_kms_key_arn                = module.kms.key_arns["efs"]
  logs_kms_key_arn               = module.kms.key_arns["logs"]
  secrets_kms_key_arn            = module.kms.key_arns["secrets"]
  ecr_kms_key_arn                = module.kms.key_arns["ecr"]
}

module "edge" {
  source                     = "../edge"
  name_prefix                = local.name_prefix
  vpc_id                     = module.network.vpc_id
  vpc_cidr_block             = module.network.vpc_cidr_block
  public_subnet_ids          = module.network.public_subnet_ids
  primary_domain             = var.web_domain
  alternate_domains          = [var.api_domain, var.voice_domain]
  allowed_ingress_ipv4_cidrs = var.edge_ipv4_cidrs
  allowed_ingress_ipv6_cidrs = var.edge_ipv6_cidrs
  deletion_protection        = var.deletion_protection
  origin_verification_header = { name = "x-velyric-origin-verify", value = var.origin_verification_secret }
  targets = {
    web = {
      port              = 3000
      health_check_path = "/api/healthz/ready"
      health_check_port = 3000
      hosts             = [var.web_domain]
      priority          = 30
    }
    api = {
      port              = 4000
      health_check_path = "/healthz/ready"
      health_check_port = 4000
      hosts             = [var.api_domain]
      priority          = 20
    }
    voice = {
      port                         = 7000
      health_check_path            = "/healthz/ready"
      health_check_port            = 7001
      hosts                        = [var.voice_domain]
      priority                     = 10
      deregistration_delay_seconds = 120
    }
  }
}

module "github" {
  source                 = "../github-oidc"
  environment            = var.environment
  repository             = var.github_repository
  github_environment     = var.environment
  cluster_name           = module.cluster.cluster_name
  repository_arns        = values(module.ecr.repository_arns)
  ecr_kms_key_arn        = module.kms.key_arns["ecr"]
  create_oidc_provider   = var.create_github_oidc_provider
  create_image_publisher = var.create_github_image_publisher
}

module "ses" {
  source                  = "../ses"
  environment             = var.environment
  mail_domain             = var.mail_domain
  alerts_kms_key_arn      = module.kms.key_arns["alerts"]
  configuration_secret_id = module.secrets.ids["ses/configuration"]
}

resource "aws_s3_bucket" "audit" {
  bucket        = "${local.bucket_prefix}-audit-trail"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    id     = "retain-audit-trail"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = var.audit_trail_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.audit.arn,
      "${aws_s3_bucket.audit.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket.json
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/velyric/${local.name_prefix}/cloudtrail"
  retention_in_days = 365
  kms_key_id        = module.kms.key_arns["logs"]
}

data "aws_iam_policy_document" "cloudtrail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail" {
  name               = "${local.name_prefix}-cloudtrail"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume.json
}

data "aws_iam_policy_document" "cloudtrail" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "cloudtrail" {
  role   = aws_iam_role.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail.json
}

resource "aws_cloudtrail" "this" {
  name                          = local.name_prefix
  s3_bucket_name                = aws_s3_bucket.audit.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail.arn
  depends_on                    = [aws_s3_bucket_policy.audit]
}

module "alarms" {
  source                     = "../alarms"
  name_prefix                = local.name_prefix
  alerts_kms_key_arn         = module.kms.key_arns["alerts"]
  alert_emails               = var.alert_emails
  alb_arn_suffix             = module.edge.alb_arn_suffix
  target_group_arn_suffixes  = module.edge.target_group_arn_suffixes
  postgres_instance_id       = module.database.postgres_instance_id
  redis_replication_group_id = module.database.redis_replication_group_id
  cluster_name               = module.cluster.cluster_name
  cloudtrail_log_group_name  = aws_cloudwatch_log_group.cloudtrail.name
  critical_services = {
    web              = var.service_sizes["web"].min
    control-api      = var.service_sizes["control-api"].min
    voice-runtime    = var.service_sizes["voice-runtime"].min
    metering-worker  = var.service_sizes["metering-worker"].min
    workflow-worker  = var.service_sizes["workflow-worker"].min
    connector-worker = var.service_sizes["connector-worker"].min
  }
}

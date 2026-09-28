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
  }
}

resource "aws_security_group" "postgres" {
  name_prefix = "${var.name}-postgres-"
  vpc_id      = var.vpc_id
  description = "PostgreSQL access from application tasks"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.postgres.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "this" {
  name_prefix = "${var.name}-"
  subnet_ids  = var.data_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name}-pg18-"
  family      = "postgres18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.3"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.slow_query_ms)
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  parameter {
    name  = "statement_timeout"
    value = "30000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name_prefix        = "${var.name}-rds-mon-"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier                            = var.name
  engine                                = "postgres"
  engine_version                        = var.postgres_engine_version
  instance_class                        = var.postgres_instance_class
  allocated_storage                     = var.postgres_allocated_storage_gb
  max_allocated_storage                 = var.postgres_max_allocated_storage_gb
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = var.database_kms_key_arn
  db_name                               = "velyric"
  username                              = "velyric_admin"
  manage_master_user_password           = true
  master_user_secret_kms_key_id         = var.secrets_kms_key_arn
  multi_az                              = var.multi_az
  db_subnet_group_name                  = aws_db_subnet_group.this.name
  vpc_security_group_ids                = [aws_security_group.postgres.id]
  parameter_group_name                  = aws_db_parameter_group.this.name
  publicly_accessible                   = false
  iam_database_authentication_enabled   = true
  backup_retention_period               = var.backup_retention_days
  backup_window                         = "01:00-02:00"
  maintenance_window                    = "sun:02:30-sun:03:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = var.deletion_protection
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${var.name}-final"
  auto_minor_version_upgrade            = true
  allow_major_version_upgrade           = false
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.database_kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 30
  monitoring_role_arn                   = aws_iam_role.monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  apply_immediately                     = false
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.name}-redis-"
  vpc_id      = var.vpc_id
  description = "Redis access from application tasks"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "random_password" "redis" {
  length           = 48
  special          = true
  override_special = "-_.~"
}

resource "aws_elasticache_user" "default" {
  user_id       = "${var.name}-default"
  user_name     = "default"
  engine        = "valkey"
  access_string = "off ~* -@all"
  authentication_mode {
    type = "no-password-required"
  }
}

resource "aws_elasticache_user" "app" {
  user_id       = "${var.name}-velyric"
  user_name     = "velyric"
  engine        = "valkey"
  access_string = "on ~vly:* &* +@all -@dangerous"
  authentication_mode {
    type      = "password"
    passwords = [random_password.redis.result]
  }
}

resource "aws_elasticache_user_group" "this" {
  user_group_id = var.name
  engine        = "valkey"
  user_ids      = [aws_elasticache_user.default.user_id, aws_elasticache_user.app.user_id]
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "velyric ${var.name} cache, rate limits and runtime coordination"
  engine                     = "valkey"
  engine_version             = var.cache_engine_version
  node_type                  = var.cache_node_type
  num_cache_clusters         = var.cache_replicas + 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = var.cache_replicas > 0
  multi_az_enabled           = var.cache_replicas > 0
  at_rest_encryption_enabled = true
  kms_key_id                 = var.cache_kms_key_arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  user_group_ids             = [aws_elasticache_user_group.this.user_group_id]
  snapshot_retention_limit   = 3
  snapshot_window            = "02:00-03:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true
  apply_immediately          = false
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id     = var.redis_auth_secret_id
  secret_string = "rediss://${aws_elasticache_user.app.user_name}:${urlencode(random_password.redis.result)}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
}

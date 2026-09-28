terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = var.alerts_kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name_prefix}-alb-target-5xx-rate"
  alarm_description   = "More than 1% of public requests returned 5xx for 5 minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  metric_query {
    id          = "rate"
    expression  = "IF(requests > 50, 100 * errors / requests, 0)"
    label       = "5xx percent"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "target_latency" {
  for_each            = var.target_group_arn_suffixes
  alarm_name          = "${var.name_prefix}-${each.key}-p95-latency"
  alarm_description   = "p95 target response time above ${var.latency_p95_seconds}s for ${each.key}"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.latency_p95_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each            = var.target_group_arn_suffixes
  alarm_name          = "${var.name_prefix}-${each.key}-unhealthy-targets"
  alarm_description   = "Unhealthy targets behind the public ALB for ${each.key}"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-postgres-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.postgres_instance_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name_prefix}-postgres-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.postgres_free_storage_bytes_threshold
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.postgres_instance_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "rds_memory" {
  alarm_name          = "${var.name_prefix}-postgres-freeable-memory"
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 268435456
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = var.postgres_instance_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${var.name_prefix}-redis-engine-cpu"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ReplicationGroupId = var.redis_replication_group_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${var.name_prefix}-redis-memory"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ReplicationGroupId = var.redis_replication_group_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "service_running_tasks" {
  for_each            = var.critical_services
  alarm_name          = "${var.name_prefix}-${each.key}-running-tasks"
  alarm_description   = "${each.key} has fewer than ${each.value} running tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.key }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "service_memory" {
  for_each            = var.critical_services
  alarm_name          = "${var.name_prefix}-${each.key}-memory"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.key }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_log_metric_filter" "openai_admin_key_access" {
  name           = "${var.name_prefix}-openai-admin-key-access"
  log_group_name = var.cloudtrail_log_group_name
  pattern        = "{ ($.eventSource = \"secretsmanager.amazonaws.com\") && ($.eventName = \"GetSecretValue\") && ($.requestParameters.secretId = \"*openai/admin-key*\") }"
  metric_transformation {
    name      = "OpenAiAdminKeyAccess"
    namespace = "Velyric/${var.name_prefix}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "openai_admin_key_access" {
  alarm_name          = "${var.name_prefix}-openai-admin-key-access"
  alarm_description   = "The OpenAI Admin API key secret was read; confirm it was a provisioning activity"
  namespace           = "Velyric/${var.name_prefix}"
  metric_name         = "OpenAiAdminKeyAccess"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
}

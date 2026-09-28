terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

data "aws_region" "current" {}

locals {
  family = "${var.name_prefix}-${var.service}"
  container_environment = [
    for key in sort(keys(var.environment_variables)) : { name = key, value = var.environment_variables[key] }
  ]
  container_secrets = [
    for key in sort(keys(var.secrets)) : { name = key, valueFrom = var.secrets[key] }
  ]
  secret_arns = distinct([
    for value in values(var.secrets) : join(":", slice(split(":", value), 0, 7))
  ])
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/velyric/${var.name_prefix}/${var.service}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.family}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "PullImages"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "PullRepository"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [var.repository_arn]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []
    content {
      sid       = "InjectSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }

  statement {
    sid       = "DecryptInjectedSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn, var.ecr_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role" "task" {
  name               = local.family
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "exec" {
  statement {
    sid = "EcsExec"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "exec" {
  count  = var.enable_execute_command ? 1 : 0
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.exec.json
}

resource "aws_iam_role_policy" "task" {
  count  = var.task_policy_json == null ? 0 : 1
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage {
    size_in_gib = var.ephemeral_storage_gib
  }

  dynamic "volume" {
    for_each = var.efs_volume == null ? [] : [var.efs_volume]
    content {
      name = "data"
      efs_volume_configuration {
        file_system_id     = volume.value.file_system_id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = volume.value.access_point_id
          iam             = "ENABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([
    {
      name                   = var.service
      image                  = var.image
      essential              = true
      command                = var.command
      readonlyRootFilesystem = var.readonly_root_filesystem
      stopTimeout            = var.stop_timeout_seconds
      user                   = var.container_user
      portMappings = [
        for mapping in var.port_mappings : {
          name          = mapping.name
          containerPort = mapping.port
          hostPort      = mapping.port
          protocol      = "tcp"
          appProtocol   = mapping.app_protocol
        }
      ]
      environment = local.container_environment
      secrets     = local.container_secrets
      mountPoints = var.efs_volume == null ? [] : [
        { sourceVolume = "data", containerPath = var.efs_volume.container_path, readOnly = false }
      ]
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      healthCheck = var.health_check_command == null ? null : {
        command     = var.health_check_command
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = var.health_check_start_period_seconds
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = var.service
          mode                  = "non-blocking"
          max-buffer-size       = "25m"
        }
      }
    }
  ])
}

resource "aws_service_discovery_service" "this" {
  count = var.service_discovery_namespace_id == null ? 0 : 1
  name  = var.service_discovery_name == null ? var.service : var.service_discovery_name
  dns_config {
    namespace_id   = var.service_discovery_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "this" {
  name                               = var.service
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = var.enable_execute_command
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = length(var.load_balancers) > 0 ? var.health_check_start_period_seconds : null
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.load_balancers
    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.service
      container_port   = load_balancer.value.container_port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this
    content {
      registry_arn = service_registries.value.arn
    }
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  count              = var.autoscaling == null ? 0 : 1
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${element(split("/", var.cluster_arn), 1)}/${aws_ecs_service.this.name}"
  min_capacity       = var.autoscaling.min
  max_capacity       = var.autoscaling.max
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.autoscaling == null ? 0 : 1
  name               = "${local.family}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling.cpu_target
    scale_in_cooldown  = var.autoscaling.scale_in_cooldown_seconds
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

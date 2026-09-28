terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : (
    "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
  )
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "images_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "images" {
  count                = var.create_image_publisher ? 1 : 0
  name                 = "velyric-github-image-publisher"
  assume_role_policy   = data.aws_iam_policy_document.images_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "images" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = var.repository_arns
  }
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.ecr_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "images" {
  count  = var.create_image_publisher ? 1 : 0
  role   = aws_iam_role.images[0].id
  policy = data.aws_iam_policy_document.images.json
}

resource "aws_iam_role" "deploy" {
  name                 = "velyric-${var.environment}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:TagResource",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "EcsUpdateServices"
    actions   = ["ecs:UpdateService"]
    resources = ["arn:aws:ecs:${local.region}:${local.account_id}:service/${var.cluster_name}/*"]
  }
  statement {
    sid       = "RunMigrations"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${local.region}:${local.account_id}:task-definition/velyric-${var.environment}-db-migrate:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:${local.region}:${local.account_id}:cluster/${var.cluster_name}"]
    }
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/velyric-${var.environment}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "ReadImages"
    actions   = ["ecr:DescribeImages", "ecr:BatchGetImage"]
    resources = var.repository_arns
  }
  statement {
    sid       = "ReadMigrationLogs"
    actions   = ["logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/velyric/velyric-${var.environment}/db-migrate:*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

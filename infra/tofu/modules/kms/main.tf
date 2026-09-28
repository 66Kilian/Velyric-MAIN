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

data "aws_partition" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
}

data "aws_iam_policy_document" "key" {
  for_each = toset(var.purposes)

  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "CloudWatchLogs"
      actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["logs.${var.region}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${data.aws_partition.current.partition}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "alerts" ? [1] : []
    content {
      sid       = "AlarmPublishing"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each                = toset(var.purposes)
  description             = "velyric ${var.environment} ${each.key}"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.key[each.key].json
  tags                    = { Purpose = each.key }
}

resource "aws_kms_alias" "this" {
  for_each      = toset(var.purposes)
  name          = "alias/velyric-${var.environment}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}

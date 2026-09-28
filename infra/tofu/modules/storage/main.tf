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
  purposes = toset(["knowledge", "artifacts", "recordings", "exports", "evidence", "transient"])
}

resource "aws_s3_bucket" "this" {
  for_each            = local.purposes
  bucket              = "${var.bucket_prefix}-${each.key}"
  object_lock_enabled = each.key == "evidence"
  force_destroy       = false
  tags                = { Purpose = each.key }
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.purposes
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.purposes
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.purposes
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.purposes
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arns["s3-${each.key}"]
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.this["evidence"].id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.evidence_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.purposes
  bucket   = aws_s3_bucket.this[each.key].id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = each.key == "evidence" ? var.evidence_retention_days : var.noncurrent_version_days
    }
  }

  dynamic "rule" {
    for_each = each.key == "transient" ? [1] : []
    content {
      id     = "expire-transient"
      status = "Enabled"
      filter {}
      expiration {
        days = 1
      }
    }
  }

  dynamic "rule" {
    for_each = each.key == "exports" ? [1] : []
    content {
      id     = "expire-exports"
      status = "Enabled"
      filter {}
      expiration {
        days = var.export_retention_days
      }
    }
  }

  dynamic "rule" {
    for_each = each.key == "recordings" ? [1] : []
    content {
      id     = "recordings-infrequent-access"
      status = "Enabled"
      filter {}
      transition {
        days          = 30
        storage_class = "STANDARD_IA"
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_cors_configuration" "transient" {
  bucket = aws_s3_bucket.this["transient"].id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.upload_allowed_origins
    allowed_headers = ["content-type", "content-length", "content-md5", "x-amz-checksum-sha256"]
    max_age_seconds = 600
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = local.purposes

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this[each.key].arn,
      "${aws_s3_bucket.this[each.key].arn}/*",
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

  statement {
    sid       = "DenyForeignKmsKeys"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.kms_key_arns["s3-${each.key}"]]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each   = local.purposes
  bucket     = aws_s3_bucket.this[each.key].id
  policy     = data.aws_iam_policy_document.bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

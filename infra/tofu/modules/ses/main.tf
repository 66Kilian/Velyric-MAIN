terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

resource "aws_sesv2_email_identity" "this" {
  email_identity         = var.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = "bounce.${var.mail_domain}"
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = "velyric-${var.environment}"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sns_topic" "events" {
  name              = "velyric-${var.environment}-ses-events"
  kms_master_key_id = var.alerts_kms_key_arn
}

data "aws_iam_policy_document" "events" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events.json
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "delivery-events"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"]
    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }
}

resource "aws_secretsmanager_secret_version" "configuration" {
  secret_id = var.configuration_secret_id
  secret_string = jsonencode({
    configuration_set = aws_sesv2_configuration_set.this.configuration_set_name
    identity_arn      = aws_sesv2_email_identity.this.arn
    from_domain       = var.mail_domain
  })
}

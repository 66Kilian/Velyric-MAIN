terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  vpc_id      = var.vpc_id
  description = "Public ALB reachable only from the Cloudflare edge and provider webhook ranges"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "https_ipv4" {
  for_each          = toset(var.allowed_ingress_ipv4_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "https_ipv6" {
  for_each          = toset(var.allowed_ingress_ipv6_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv6         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "targets" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 1024
  to_port           = 65535
}

resource "aws_lb" "this" {
  name                             = "${var.name_prefix}-public"
  internal                         = false
  load_balancer_type               = "application"
  subnets                          = var.public_subnet_ids
  security_groups                  = [aws_security_group.alb.id]
  drop_invalid_header_fields       = true
  enable_deletion_protection       = var.deletion_protection
  idle_timeout                     = 120
  desync_mitigation_mode           = "strictest"
  enable_http2                     = true
  preserve_host_header             = true
  xff_header_processing_mode       = "append"
  enable_cross_zone_load_balancing = true

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = "alb/${var.name_prefix}"
    enabled = var.access_logs_bucket != null
  }
}

resource "aws_acm_certificate" "this" {
  domain_name               = var.primary_domain
  subject_alternative_names = var.alternate_domains
  validation_method         = "DNS"
  key_algorithm             = "EC_prime256v1"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "this" {
  for_each             = var.targets
  name                 = "${var.name_prefix}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  protocol_version     = "HTTP1"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = each.value.deregistration_delay_seconds
  slow_start           = 30

  health_check {
    path                = each.value.health_check_path
    port                = tostring(each.value.health_check_port)
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }

  stickiness {
    type    = "lb_cookie"
    enabled = false
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = aws_acm_certificate.this.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":{\"code\":\"NOT_FOUND\"}}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each     = var.targets
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    host_header {
      values = each.value.hosts
    }
  }

  dynamic "condition" {
    for_each = length(each.value.path_patterns) > 0 ? [1] : []
    content {
      path_pattern {
        values = each.value.path_patterns
      }
    }
  }

  dynamic "condition" {
    for_each = var.origin_verification_header == null ? [] : [1]
    content {
      http_header {
        http_header_name = var.origin_verification_header.name
        values           = [var.origin_verification_header.value]
      }
    }
  }
}

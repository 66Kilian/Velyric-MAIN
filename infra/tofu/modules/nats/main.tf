terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.1"
    }
  }
}

locals {
  nodes       = [for index in range(var.node_count) : "nats-${index}"]
  route_names = [for node in local.nodes : "${node}.${var.internal_domain}"]
  data_dir    = "/data"
  run_dir     = "/tmp/nats"
  node_configs = {
    for node in local.nodes : node => join("\n", [
      "server_name: ${node}",
      "listen: 0.0.0.0:4222",
      "http: 0.0.0.0:8222",
      "max_payload: 1MB",
      "write_deadline: \"10s\"",
      "lame_duck_duration: \"30s\"",
      "lame_duck_grace_period: \"10s\"",
      "tls {",
      "  cert_file: \"${local.run_dir}/tls.crt\"",
      "  key_file: \"${local.run_dir}/tls.key\"",
      "  ca_file: \"${local.run_dir}/ca.crt\"",
      "  timeout: 5",
      "}",
      "jetstream {",
      "  store_dir: \"${local.data_dir}/jetstream\"",
      "  max_file_store: ${var.max_file_store_bytes}",
      "  max_memory_store: ${var.max_memory_store_bytes}",
      "}",
      "cluster {",
      "  name: \"velyric-${var.environment}\"",
      "  listen: 0.0.0.0:6222",
      "  routes: [${join(", ", [for name in local.route_names : "\"nats-route://${name}:6222\""])}]",
      "  tls {",
      "    cert_file: \"${local.run_dir}/tls.crt\"",
      "    key_file: \"${local.run_dir}/tls.key\"",
      "    ca_file: \"${local.run_dir}/ca.crt\"",
      "    verify: true",
      "    timeout: 5",
      "  }",
      "}",
      "include \"resolver.conf\"",
    ])
  }
  entrypoint = join(" && ", [
    "umask 077",
    "mkdir -p ${local.run_dir} ${local.data_dir}/jetstream ${local.data_dir}/jwt",
    "printf '%s' \"$NATS_TLS_CERT\" > ${local.run_dir}/tls.crt",
    "printf '%s' \"$NATS_TLS_KEY\" > ${local.run_dir}/tls.key",
    "printf '%s' \"$NATS_TLS_CA\" > ${local.run_dir}/ca.crt",
    "printf '%s' \"$NATS_RESOLVER_CONFIG\" > ${local.run_dir}/resolver.conf",
    "printf '%s' \"$NATS_SERVER_CONFIG\" > ${local.run_dir}/nats.conf",
    "unset NATS_TLS_KEY NATS_RESOLVER_CONFIG",
    "exec nats-server -c ${local.run_dir}/nats.conf",
  ])
}

resource "aws_security_group" "nats" {
  name_prefix = "${var.name_prefix}-nats-"
  vpc_id      = var.vpc_id
  description = "NATS JetStream cluster"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.nats.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4222
  to_port                      = 4222
}

resource "aws_vpc_security_group_ingress_rule" "nlb_clients" {
  security_group_id = aws_security_group.nats.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 4222
  to_port           = 4222
  description       = "Internal NLB health checks and forwarded client traffic"
}

resource "aws_vpc_security_group_ingress_rule" "routes" {
  security_group_id            = aws_security_group.nats.id
  referenced_security_group_id = aws_security_group.nats.id
  ip_protocol                  = "tcp"
  from_port                    = 6222
  to_port                      = 6222
}

resource "aws_vpc_security_group_ingress_rule" "monitoring" {
  security_group_id = aws_security_group.nats.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 8222
  to_port           = 8222
}

resource "aws_vpc_security_group_egress_rule" "nats" {
  security_group_id = aws_security_group.nats.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.name_prefix}-nats-efs-"
  vpc_id      = var.vpc_id
  description = "NATS JetStream storage"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "efs" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.nats.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_efs_file_system" "this" {
  creation_token   = "${var.name_prefix}-nats"
  encrypted        = true
  kms_key_id       = var.efs_kms_key_arn
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"
  tags             = { Name = "${var.name_prefix}-nats" }
}

resource "aws_efs_backup_policy" "this" {
  file_system_id = aws_efs_file_system.this.id
  backup_policy {
    status = "ENABLED"
  }
}

resource "aws_efs_mount_target" "this" {
  for_each        = { for index, subnet in var.data_subnet_ids : tostring(index) => subnet }
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "node" {
  for_each       = toset(local.nodes)
  file_system_id = aws_efs_file_system.this.id
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/${each.key}"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0700"
    }
  }
  tags = { Name = "${var.name_prefix}-${each.key}" }
}

resource "aws_lb" "clients" {
  name                             = "${var.name_prefix}-nats"
  internal                         = true
  load_balancer_type               = "network"
  subnets                          = var.app_subnet_ids
  security_groups                  = [aws_security_group.nlb.id]
  enable_cross_zone_load_balancing = true
}

resource "aws_security_group" "nlb" {
  name_prefix = "${var.name_prefix}-nats-nlb-"
  vpc_id      = var.vpc_id
  description = "Internal NATS client load balancer"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "nlb" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.nlb.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4222
  to_port                      = 4222
}

resource "aws_vpc_security_group_egress_rule" "nlb" {
  security_group_id            = aws_security_group.nlb.id
  referenced_security_group_id = aws_security_group.nats.id
  ip_protocol                  = "tcp"
  from_port                    = 4222
  to_port                      = 4222
}

resource "aws_lb_target_group" "clients" {
  name                 = "${var.name_prefix}-nats"
  port                 = 4222
  protocol             = "TCP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 60
  health_check {
    protocol            = "HTTP"
    port                = "8222"
    path                = "/healthz?js-enabled-only=true"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
  }
}

resource "aws_lb_listener" "clients" {
  load_balancer_arn = aws_lb.clients.arn
  port              = 4222
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.clients.arn
  }
}

resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P384"
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 87600
  early_renewal_hours   = 8760
  allowed_uses          = ["cert_signing", "crl_signing"]
  subject {
    common_name  = "velyric-${var.environment} NATS CA"
    organization = "Velyric"
  }
}

resource "tls_private_key" "server" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = concat(local.route_names, [aws_lb.clients.dns_name, "localhost"])
  subject {
    common_name  = "nats.${var.internal_domain}"
    organization = "Velyric"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 8760
  early_renewal_hours   = 1440
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth", "client_auth"]
}

resource "aws_secretsmanager_secret" "tls" {
  name                    = "velyric/${var.environment}/nats/tls"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "tls" {
  secret_id = aws_secretsmanager_secret.tls.id
  secret_string = jsonencode({
    ca   = tls_self_signed_cert.ca.cert_pem
    cert = tls_locally_signed_cert.server.cert_pem
    key  = tls_private_key.server.private_key_pem
  })
}

resource "aws_secretsmanager_secret" "resolver" {
  name                    = "velyric/${var.environment}/nats/resolver"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 7
  description             = "nats-server operator, system_account and resolver block managed with nsc"
}

data "aws_iam_policy_document" "efs" {
  statement {
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [aws_efs_file_system.this.arn]
    condition {
      test     = "Bool"
      variable = "elasticfilesystem:AccessedViaMountTarget"
      values   = ["true"]
    }
  }
}

module "node" {
  source   = "../ecs-service"
  for_each = toset(local.nodes)

  name_prefix         = var.name_prefix
  service             = each.key
  cluster_arn         = var.cluster_arn
  image               = var.image
  repository_arn      = var.repository_arn
  container_user      = "1000:1000"
  command             = ["sh", "-c", local.entrypoint]
  cpu                 = var.cpu
  memory              = var.memory
  subnet_ids          = var.app_subnet_ids
  security_group_id   = aws_security_group.nats.id
  desired_count       = 1
  logs_kms_key_arn    = var.logs_kms_key_arn
  secrets_kms_key_arn = var.secrets_kms_key_arn
  ecr_kms_key_arn     = var.ecr_kms_key_arn
  task_policy_json    = data.aws_iam_policy_document.efs.json

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  stop_timeout_seconds               = 60

  port_mappings = [
    { name = "client", port = 4222, app_protocol = null },
    { name = "route", port = 6222, app_protocol = null },
    { name = "monitor", port = 8222, app_protocol = "http" },
  ]

  environment_variables = {
    NATS_SERVER_CONFIG = local.node_configs[each.key]
  }

  secrets = {
    NATS_TLS_CERT        = "${aws_secretsmanager_secret.tls.arn}:cert::"
    NATS_TLS_KEY         = "${aws_secretsmanager_secret.tls.arn}:key::"
    NATS_TLS_CA          = "${aws_secretsmanager_secret.tls.arn}:ca::"
    NATS_RESOLVER_CONFIG = "${aws_secretsmanager_secret.resolver.arn}:resolver_conf::"
  }

  efs_volume = {
    file_system_id  = aws_efs_file_system.this.id
    access_point_id = aws_efs_access_point.node[each.key].id
    container_path  = local.data_dir
  }

  load_balancers = [
    { target_group_arn = aws_lb_target_group.clients.arn, container_port = 4222 },
  ]

  service_discovery_namespace_id = var.service_discovery_namespace_id
  health_check_command           = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8222/healthz || exit 1"]

  depends_on = [aws_efs_mount_target.this, aws_secretsmanager_secret_version.tls]
}

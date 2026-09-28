resource "aws_security_group" "service" {
  for_each    = local.services
  name        = "${local.name_prefix}-${each.key}"
  vpc_id      = module.network.vpc_id
  description = "velyric ${var.environment} ${each.key} tasks"
}

resource "aws_vpc_security_group_egress_rule" "service" {
  for_each          = local.services
  security_group_id = aws_security_group.service[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

locals {
  public_ingress = {
    web           = 3000
    control-api   = 4000
    voice-runtime = 7000
    voice-admin   = 7001
  }
  internal_api_clients = ["web", "voice-runtime", "workflow-worker", "connector-worker", "document-worker", "eval-runner", "metering-worker"]
  otel_clients         = ["web", "control-api", "voice-runtime", "metering-worker", "workflow-worker", "connector-worker", "document-worker", "eval-runner"]
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each                     = local.public_ingress
  security_group_id            = aws_security_group.service[each.key == "voice-admin" ? "voice-runtime" : each.key].id
  referenced_security_group_id = module.edge.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_vpc_security_group_ingress_rule" "control_api_internal" {
  for_each                     = toset(local.internal_api_clients)
  security_group_id            = aws_security_group.service["control-api"].id
  referenced_security_group_id = aws_security_group.service[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4001
}

resource "aws_vpc_security_group_ingress_rule" "clamav" {
  security_group_id            = aws_security_group.service["clamav"].id
  referenced_security_group_id = aws_security_group.service["document-worker"].id
  ip_protocol                  = "tcp"
  from_port                    = 3310
  to_port                      = 3310
}

resource "aws_vpc_security_group_ingress_rule" "otel" {
  for_each                     = toset(local.otel_clients)
  security_group_id            = aws_security_group.service["otel-collector"].id
  referenced_security_group_id = aws_security_group.service[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 4317
  to_port                      = 4318
}

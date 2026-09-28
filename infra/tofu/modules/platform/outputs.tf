output "alb_dns_name" {
  value = module.edge.alb_dns_name
}

output "certificate_validation_records" {
  value = module.edge.certificate_validation_records
}

output "ses_dkim_tokens" {
  value = module.ses.dkim_tokens
}

output "nat_public_ips" {
  value = module.network.nat_public_ips
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "cluster_name" {
  value = module.cluster.cluster_name
}

output "github_deploy_role_arn" {
  value = module.github.deploy_role_arn
}

output "github_image_publisher_role_arn" {
  value = module.github.image_publisher_role_arn
}

output "db_migrate_task_definition_family" {
  value = aws_ecs_task_definition.db_migrate.family
}

output "db_migrate_network" {
  value = {
    subnets         = module.network.app_subnet_ids
    security_groups = [aws_security_group.db_migrate.id]
  }
}

output "postgres_endpoint" {
  value = module.database.postgres_endpoint
}

output "postgres_master_secret_arn" {
  value = module.database.postgres_master_secret_arn
}

output "nats_client_url" {
  value = module.nats.client_url
}

output "nats_resolver_secret_arn" {
  value = module.nats.resolver_secret_arn
}

output "alerts_topic_arn" {
  value = module.alarms.alerts_topic_arn
}

output "service_names" {
  value = [
    module.web.service_name,
    module.control_api.service_name,
    module.voice_runtime.service_name,
    module.metering_worker.service_name,
    module.workflow_worker.service_name,
    module.connector_worker.service_name,
    module.document_worker.service_name,
    module.eval_runner.service_name,
    module.clamav.service_name,
    module.otel_collector.service_name,
  ]
}

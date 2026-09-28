output "postgres_endpoint" {
  value = aws_db_instance.this.address
}

output "postgres_port" {
  value = aws_db_instance.this.port
}

output "postgres_instance_id" {
  value = aws_db_instance.this.identifier
}

output "postgres_master_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "postgres_security_group_id" {
  value = aws_security_group.postgres.id
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "redis_replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}

output "redis_security_group_id" {
  value = aws_security_group.redis.id
}

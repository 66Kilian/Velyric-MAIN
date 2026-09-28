output "arns" {
  value = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}

output "ids" {
  value = { for name, secret in aws_secretsmanager_secret.this : name => secret.id }
}

output "client_url" {
  value = "tls://${aws_lb.clients.dns_name}:4222"
}

output "ca_certificate_pem" {
  value = tls_self_signed_cert.ca.cert_pem
}

output "security_group_id" {
  value = aws_security_group.nats.id
}

output "resolver_secret_arn" {
  value = aws_secretsmanager_secret.resolver.arn
}

output "tls_secret_arn" {
  value = aws_secretsmanager_secret.tls.arn
}

output "identity_arn" {
  value = aws_sesv2_email_identity.this.arn
}

output "configuration_set_name" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "events_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "dkim_tokens" {
  value = aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens
}

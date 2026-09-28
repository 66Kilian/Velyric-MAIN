output "key_arns" {
  value = { for purpose, key in aws_kms_key.this : purpose => key.arn }
}

output "key_ids" {
  value = { for purpose, key in aws_kms_key.this : purpose => key.key_id }
}

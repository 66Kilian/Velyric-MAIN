output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_arns" {
  value = { for name, group in aws_lb_target_group.this : name => group.arn }
}

output "target_group_arn_suffixes" {
  value = { for name, group in aws_lb_target_group.this : name => group.arn_suffix }
}

output "certificate_validation_records" {
  value = [
    for option in aws_acm_certificate.this.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}

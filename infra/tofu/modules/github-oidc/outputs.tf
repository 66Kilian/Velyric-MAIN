output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "image_publisher_role_arn" {
  value = var.create_image_publisher ? aws_iam_role.images[0].arn : null
}

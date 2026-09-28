output "bucket_names" {
  value = { for purpose, bucket in aws_s3_bucket.this : purpose => bucket.bucket }
}

output "bucket_arns" {
  value = { for purpose, bucket in aws_s3_bucket.this : purpose => bucket.arn }
}

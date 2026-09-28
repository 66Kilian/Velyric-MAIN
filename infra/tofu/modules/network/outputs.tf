output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "availability_zones" {
  value = local.azs
}

output "public_subnet_ids" {
  value = [for az in local.azs : aws_subnet.this["public-${az}"].id]
}

output "app_subnet_ids" {
  value = [for az in local.azs : aws_subnet.this["app-${az}"].id]
}

output "data_subnet_ids" {
  value = [for az in local.azs : aws_subnet.this["data-${az}"].id]
}

output "nat_public_ips" {
  value = [for eip in aws_eip.nat : eip.public_ip]
}

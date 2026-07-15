output "internet_gateway_id" {
  value = aws_internet_gateway.igw.id
}

output "vps_a_merge_conflict_survivors_private_ip" {
  value = aws_instance.vps_a_merge_conflict_survivors.private_ip
}

output "vps_b_merge_conflict_survivors_private_ip" {
  value = aws_instance.vps_b_merge_conflict_survivors.private_ip
}

output "eks_cluster_name" {
  value = aws_eks_cluster.main.name
}

output "eks_cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "route53_nameservers" {
  description = "Route 53 nameservers for kosmiha.eu - update your domain registrar with these"
  value       = aws_route53_zone.kosmiha.name_servers
}

output "route53_zone_id" {
  description = "Route 53 hosted zone ID for kosmiha.eu"
  value       = aws_route53_zone.kosmiha.zone_id
}

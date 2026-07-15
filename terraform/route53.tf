resource "aws_route53_zone" "kosmiha" {
  name = "kosmiha.eu"

  tags = {
    Name = "kosmiha-eu-zone"
  }
}

resource "aws_route53_record" "eks" {
  zone_id = aws_route53_zone.kosmiha.zone_id
  name    = "eks.kosmiha.eu"
  type    = "CNAME"
  ttl     = 300

  records = [aws_eks_cluster.main.endpoint]
}

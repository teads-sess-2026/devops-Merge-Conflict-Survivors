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

resource "aws_route53_record" "eks_wildcard" {
  zone_id = aws_route53_zone.kosmiha.zone_id
  name    = "*.eks.kosmiha.eu"
  type    = "CNAME"
  ttl     = 300

  records = ["abf3e42a7395b4e55b0489587e0a714a-757749edbbad969b.elb.eu-west-1.amazonaws.com"]
}

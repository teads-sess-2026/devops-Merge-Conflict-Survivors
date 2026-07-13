data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_instance" "vps_a_merge_conflict_survivors" {
  ami           = data.aws_ami.amazon_linux.id
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.private_a.id

  vpc_security_group_ids = [aws_security_group.vps_merge_conflict_survivors.id]

  tags = { Name = "vps-a-merge-conflict-survivors" }
}

resource "aws_instance" "vps_b_merge_conflict_survivors" {
  ami           = data.aws_ami.amazon_linux.id
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.private_b.id

  vpc_security_group_ids = [aws_security_group.vps_merge_conflict_survivors.id]

  tags = { Name = "vps-b-merge-conflict-survivors" }
}

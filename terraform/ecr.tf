resource "aws_ecr_repository" "app" {
  name                 = "merge-conflict-survivors"
  image_tag_mutability = "MUTABLE"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "merge-conflict-survivors" }
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.app.repository_url
  description = "ECR repository URL"
}

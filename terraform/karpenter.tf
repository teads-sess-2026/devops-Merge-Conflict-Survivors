resource "aws_iam_role" "karpenter_controller" {
  name               = "KarpenterControllerRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:karpenter:karpenter"
        }
      }
    }]
  })
  permissions_boundary = "arn:aws:iam::937697200280:policy/summer-school-ljubljana-boundary"
}

resource "aws_iam_role_policy" "karpenter_controller" {
  name = "KarpenterControllerPolicy"
  role = aws_iam_role.karpenter_controller.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:CreateFleet",
          "ec2:CreateLaunchTemplate",
          "ec2:CreateTags",
          "ec2:DescribeImages",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeSpotPriceHistory",
          "ec2:DescribeVpcs",
          "ec2:GetLaunchTemplateData",
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:DeleteLaunchTemplate",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "pricing:GetProducts",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
        ]
        Resource = "arn:aws:ssm:eu-west-1::parameter/aws/service/eks/optimized-ami/*"
      },
    ]
  })
}



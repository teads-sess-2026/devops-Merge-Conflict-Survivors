terraform {
  backend "s3" {
    bucket       = "summer-school-terraform-state-merge-conflict-survivors"
    key          = "terraform.tfstate"
    region       = "eu-west-1"
    profile      = "summer-school"
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region  = "eu-west-1"
  profile = "summer-school"
}

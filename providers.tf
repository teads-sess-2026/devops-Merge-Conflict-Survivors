terraform {
  backend "s3" {
    bucket  = "summer-school-terraform-state-merge-conflict-survivors"
    key     = "terraform.tfstate"
    region  = "eu-west-1"
    profile = "summer-school"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = "eu-west-1"
  profile = "summer-school"
}

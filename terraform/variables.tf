variable "github_token" {
  description = "GitHub personal access token for Flux"
  type        = string
  sensitive   = true
}

variable "github_repo_url" {
  description = "GitHub repository URL for Flux to sync"
  type        = string
  default     = "https://github.com/teads-sess-2026/teads-summer-school-2026"
}

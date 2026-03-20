variable "secrets_arn" {
  description = "ARN of the Secrets Manager secret containing app secrets (REDIS_URL, API keys, etc.)"
  type        = string
}

variable "ecr_image_uri" {
  description = "Full ECR image URI to deploy (e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/steamuready:latest)"
  type        = string
}

variable "certificate_arn" {
  description = "ARN of the ACM certificate for the domain"
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone ID for the domain"
  type        = string
}

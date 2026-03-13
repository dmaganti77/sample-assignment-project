variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "sales-tracker"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "node_instance_type" {
  description = "EC2 instance type for EKS nodes (t3.micro for free tier)"
  type        = string
  default     = "t3.micro"
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_min_size" {
  type    = number
  default = 1
}

variable "node_max_size" {
  type    = number
  default = 3
}

variable "sqs_queue_name" {
  description = "SQS queue name for sales ingestion"
  type        = string
  default     = "sales-ingestion"
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name for sales storage"
  type        = string
  default     = "sales"
}

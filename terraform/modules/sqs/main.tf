# SQS Queue + Dead Letter Queue
# Free tier: 1M requests/month (NOTE: 3M req/hr blows this in seconds — document this gap)

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.queue_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "main" {
  name                       = var.queue_name
  visibility_timeout_seconds = 300            # 5 min — set to 6x consumer processing time
  message_retention_seconds  = 86400          # 1 day
  receive_wait_time_seconds  = 20             # Long polling — reduces empty receives
  
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3  # Move to DLQ after 3 failed attempts
  })
}

variable "queue_name" {
  type = string
}

output "queue_arn" {
  value = aws_sqs_queue.main.arn
}

output "queue_url" {
  value = aws_sqs_queue.main.url
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

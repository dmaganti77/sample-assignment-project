# DynamoDB Sales Table
# Free tier: 25GB storage, 25 WCU, 25 RCU (provisioned) — on-demand has no free WCU

resource "aws_dynamodb_table" "sales" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST" # On-demand — scales automatically, no free WCU
  
  # Partition key: store_id distributes writes across 200 stores evenly
  hash_key  = "store_id"
  range_key = "sale_id"

  attribute {
    name = "store_id"
    type = "S"
  }

  attribute {
    name = "sale_id"
    type = "S"
  }

  attribute {
    name = "buyer"
    type = "S"
  }

  attribute {
    name = "sale_time"
    type = "S"
  }

  # GSI for buyer-based queries
  global_secondary_index {
    name            = "buyer-time-index"
    hash_key        = "buyer"
    range_key       = "sale_time"
    projection_type = "ALL"
  }

  # TTL for auto-expiry of old records (optional)
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

variable "table_name" {
  type = string
}

output "table_arn" {
  value = aws_dynamodb_table.sales.arn
}

output "table_name" {
  value = aws_dynamodb_table.sales.name
}

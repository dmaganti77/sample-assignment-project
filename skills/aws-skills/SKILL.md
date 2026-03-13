---
name: aws-skills
description: AWS EKS, free tier constraints, Terraform best practices, and IaC patterns for cloud infrastructure agents.
---

# AWS Skills

## EKS Best Practices

### Cluster Design
- Use managed node groups (not self-managed)
- Enable OIDC provider for IRSA (IAM Roles for Service Accounts)
- Use private endpoint for API server in production
- Enable envelope encryption for secrets with KMS
- Multi-AZ node groups: spread across at least 2 AZs

### Free Tier EKS Setup
```hcl
# t3.micro — 750 hrs/month free (first 12 months)
instance_types = ["t3.micro"]
min_size       = 1
max_size       = 3
desired_size   = 2
```

### IRSA (IAM Roles for Service Accounts)
- Never use node-level IAM roles for pod access
- Each service account gets its own IAM role
- Least privilege: only the permissions the pod needs
```hcl
# Trust policy for IRSA
condition {
  test     = "StringEquals"
  variable = "${oidc_provider}:sub"
  values   = ["system:serviceaccount:${namespace}:${service_account}"]
}
```

### KEDA for SQS-based Autoscaling
- Scale on ApproximateNumberOfMessagesVisible
- More accurate than CPU for queue-based workloads
```yaml
triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.region.amazonaws.com/account/queue-name
      queueLength: "100"        # messages per pod
      awsRegion: us-east-1
      identityOwner: operator   # uses IRSA
```

### SQS Best Practices
- Standard queue: at-least-once, best-effort ordering (cheaper, higher throughput)
- FIFO queue: exactly-once, ordered (use only if order matters — it doesn't here)
- Set visibility timeout = 6x your consumer processing time
- Dead Letter Queue: maxReceiveCount = 3 before DLQ
- MessageDeduplicationId for idempotency on FIFO, or handle in application

### DynamoDB Design for Sales Tracking
```
Table: sales
Partition Key: store_id (string)     # Distributes load across 200 stores
Sort Key: sale_id (string)           # UUID for uniqueness
TTL: expires_at                      # Optional: auto-expire old records

GSI: buyer-time-index
  Partition Key: buyer
  Sort Key: sale_time
```

**Avoid hot partitions:**
- 200 stores = 200 partition keys = even distribution
- Do NOT use sequential IDs as partition key (all writes to same shard)

### VPC Design
```
VPC: 10.0.0.0/16
  Public Subnets:  10.0.1.0/24, 10.0.2.0/24   (ALB lives here)
  Private Subnets: 10.0.10.0/24, 10.0.11.0/24 (EKS nodes live here)
```
- NAT Gateway for outbound internet from private subnets (not free — use NAT instance for free tier)
- VPC Endpoints for SQS and DynamoDB (avoids NAT costs, faster, more secure)

## Terraform Module Structure

```
terraform/
├── main.tf                 # Root module — orchestrates all modules
├── variables.tf
├── outputs.tf
├── versions.tf             # Provider version pinning
└── modules/
    ├── vpc/                # VPC, subnets, route tables, VPC endpoints
    ├── eks/                # Cluster, node group, OIDC, addons
    ├── iam/                # IRSA roles for each service account
    ├── sqs/                # Queue + DLQ + policy
    └── dynamodb/           # Table, GSI, autoscaling
```

## AWS Free Tier Reference Card

| Service        | Free Allowance                          | Watch Out For             |
|---------------|----------------------------------------|---------------------------|
| EKS            | Cluster costs $0.10/hr (NOT free)      | Use existing cluster      |
| EC2 t3.micro   | 750 hrs/month (12 months)              | 2 instances = 375 hrs each|
| DynamoDB       | 25GB storage, 25 WCU, 25 RCU           | On-demand has no free WCU |
| SQS            | 1M requests/month                       | 3M req/hr blows this fast |
| CloudWatch     | 10 custom metrics, 5GB logs             | Logs cost after 5GB       |
| ALB            | 750 hrs/month (12 months)              | LCU charges apply         |
| ECR            | 500MB/month                             | Each image layer counts   |
| Data Transfer  | 1GB/month outbound free                | EKS → internet is costly  |

> **Note:** EKS control plane costs $0.10/hr (~$72/month). For true free tier,
> use k3s on EC2 t3.micro instead of managed EKS.

## Terraform Best Practices
- Pin all provider versions in versions.tf
- Use remote state in S3 + DynamoDB locking
- Never hardcode credentials — use IAM roles
- Use `terraform workspace` for env separation
- Tag all resources: Environment, Project, ManagedBy=Terraform
- Use `lifecycle { prevent_destroy = true }` on stateful resources

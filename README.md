# Sales Tracker — Take-Home Assignment

**Problem:** Sales Tracker on Kubernetes (Project 2)
**Approach:** EPCC methodology + Claude Code subagents + Claude Skills
**LLM Used:** Claude (Anthropic) via Claude Code

---

## What Is EPCC?

A structured prompting methodology for LLM-driven problem solving:

| Phase | Agent | What It Does |
|-------|-------|-------------|
| **E**xplore | `architect` | Identifies challenges, tradeoffs, SPOFs — no solutions yet |
| **P**lan | `infrastructure` | Designs AWS architecture + IaC + ADR |
| **C**ode | `backend` | Implements Go app + Kubernetes manifests |
| **C**ompare | `reviewer` | Critiques output vs production reality |

---

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │              AWS VPC                 │
  200 Stores        │  Public Subnet                       │
  POST /sales ──────►  ┌─────┐                            │
                    │  │ ALB │                            │
                    │  └──┬──┘                            │
                    │     │         Private Subnet         │
                    │  ┌──▼──────────────────┐            │
                    │  │   EKS Cluster        │            │
                    │  │  ┌────────────────┐  │            │
                    │  │  │  API Pods (2+) │  │            │
                    │  │  │  POST /sales   │  │            │
                    │  │  └───────┬────────┘  │            │
                    │  │         │ 202 Accepted│           │
                    │  │  ┌──────▼────────┐  │            │
                    │  │  │  SQS Queue    │  │            │
                    │  │  │  (buffer)     │  │            │
                    │  │  └──────┬────────┘  │            │
                    │  │         │ KEDA scales│           │
                    │  │  ┌──────▼────────┐  │            │
                    │  │  │ Consumer Pods │  │            │
                    │  │  │ (auto-scaled) │  │            │
                    │  │  └──────┬────────┘  │            │
                    │  └─────────┼───────────┘            │
                    │            │                         │
                    │  ┌─────────▼───────┐                │
                    │  │   DynamoDB      │                │
                    │  │  (sales table)  │                │
                    │  └─────────────────┘                │
                    └─────────────────────────────────────┘
```

---

## Key Design Decisions

**Why SQS as a buffer?**
Traffic spikes from 1 to 3M req/hr in minutes. Without a queue, the database would be overwhelmed. SQS absorbs the burst and consumers process at a steady rate.

**Why KEDA over HPA?**
HPA scales on CPU/memory. For queue-based workloads, the right signal is queue depth. KEDA scales consumer pods directly based on SQS `ApproximateNumberOfMessagesVisible`.

**Why DynamoDB over RDS?**
At 3M req/hr = 833 writes/sec, DynamoDB's on-demand scaling handles this without pre-provisioning. RDS would require careful sizing and connection pooling.

**Why AP over CP (CAP Theorem)?**
A sale recorded 100ms late is acceptable. The system being unavailable is not. We choose Availability + Partition Tolerance.

**Why 202 Accepted instead of 201 Created?**
The sale is queued, not persisted yet. 202 accurately communicates async processing and keeps API latency low (~10ms vs ~100ms for direct DB write).

---

## Running Locally (Quick Start)

```bash
# Prerequisites: AWS CLI, kubectl, terraform, go 1.21+

# 1. Clone and enter project
cd sample-assignment-project

# 2. Deploy infrastructure (free tier)
cd terraform
terraform init
terraform plan
terraform apply

# 3. Build and push app
cd ../app
docker build -t sales-tracker .
# Push to ECR (see terraform outputs for ECR URL)

# 4. Deploy to EKS
kubectl apply -f ../k8s/

# 5. Test the API
curl -X POST https://<alb-dns>/sales \
  -H "Content-Type: application/json" \
  -d '{"quantity": 5, "buyer": "John Doe", "time": "2024-01-15T10:30:00Z"}'
```

---

## Compare & Contrast

See [docs/03-compare-contrast.md](docs/03-compare-contrast.md) for the full analysis of what the LLM agents got right, what they missed, and what production would require differently.

---

## Architecture Diagram

![Sales Tracker Architecture](sales-tracker-architecture.drawio.pdf)

See [docs/architecture-diagram.md](docs/architecture-diagram.md) for the full Mermaid diagram set (request flow, KEDA scaling sequence, failure scenarios, multi-AZ topology).

---

## System Design Principles Applied

- ✅ CAP Theorem — AP model chosen deliberately
- ✅ Message Queues — SQS decouples API from storage
- ✅ Load Balancing — ALB across multi-AZ
- ✅ SPOF Elimination — min 2 pods, multi-AZ nodes
- ✅ Fault Tolerance — DLQ, retries, graceful shutdown
- ✅ Idempotency — SHA256 dedup prevents duplicate sales
- ✅ Rate Limiting — ALB throttling protects downstream
- ✅ Observability — CloudWatch metrics + structured logs
- ✅ Database Sharding — DynamoDB partition by store_id

# Sales Tracker — Sample Assignment Project

## Project Context

**Problem:** Design a sales tracking backend for 200 stores.
- API: `POST /sales { "quantity": int, "buyer": string, "time": UTC }`
- Scale: 1 to 3,000,000 requests per hour
- Platform: Kubernetes (EKS on AWS free tier)
- IaC: Terraform

**Approach:** EPCC methodology with specialized subagents + Claude skills.

---

## How to Run This Project

### Step 1 — Install skills globally
```bash
mkdir -p ~/.config/claude-code/skills
cp -r skills/software-architecture ~/.config/claude-code/skills/
cp -r skills/aws-skills ~/.config/claude-code/skills/
cp -r skills/subagent-driven-development ~/.config/claude-code/skills/
```

### Step 2 — Start Claude Code in this directory
```bash
claude
```

### Step 3 — Run EPCC phases in order

**E — Explore (Architect Agent)**
```
Analyze the sales tracker problem using the architect agent.
Problem: 200 stores, POST /sales API, 1-3M requests per hour.
Identify all system design challenges before proposing any solutions.
```

**P — Plan (Infrastructure Agent)**
```
Using the challenges identified by the architect agent, design the
AWS EKS infrastructure. Apply free tier constraints. Produce an
Architecture Decision Record and Terraform module structure.
```

**C — Code (Backend Agent)**
```
Implement the Go application and Kubernetes manifests based on
the infrastructure agent's plan. Write all files to app/ and k8s/.
```

**C — Compare (Reviewer Agent)**
```
Review all agent outputs. Produce a compare and contrast analysis
between what the agents designed and what production reality requires.
Write the output to docs/03-compare-contrast.md.
```

---

## Project Structure

```
sample-assignment-project/
├── CLAUDE.md                          # This file — orchestrator instructions
├── .claude/
│   └── agents/
│       ├── architect.md               # E — Explore agent
│       ├── infrastructure.md          # P — Plan agent
│       ├── backend.md                 # C — Code agent
│       └── reviewer.md                # C — Compare agent
├── skills/
│   ├── software-architecture/         # System design principles
│   ├── aws-skills/                    # AWS EKS + Terraform patterns
│   └── subagent-driven-development/   # Agent orchestration patterns
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── versions.tf
│   └── modules/
│       ├── vpc/
│       ├── eks/
│       ├── iam/
│       ├── sqs/
│       └── dynamodb/
├── app/
│   ├── cmd/main.go
│   ├── internal/
│   │   ├── handler/sales.go
│   │   ├── queue/sqs.go
│   │   └── models/sale.go
│   ├── Dockerfile
│   └── go.mod
├── k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── keda-scaledobject.yaml
│   ├── hpa.yaml
│   ├── pdb.yaml
│   └── configmap.yaml
└── docs/
    ├── 01-exploration.md              # Architect agent output
    ├── 02-architecture-decisions.md   # Infrastructure agent ADR
    └── 03-compare-contrast.md         # Reviewer agent final analysis
```

---

## Agent Execution Order (STRICT)

```
architect → infrastructure → backend → reviewer
```

Do NOT skip phases. Each agent's output feeds the next.

---

## System Design Principles Applied

From https://github.com/ashishps1/awesome-system-design-resources:

| Principle | Where Applied |
|-----------|--------------|
| CAP Theorem | AP chosen — availability over consistency |
| Message Queues | SQS buffers 1→3M spike |
| Rate Limiting | ALB + API Gateway layer |
| SPOF Elimination | Multi-AZ EKS, 2+ pod replicas |
| Fault Tolerance | DLQ, retries, circuit breaker |
| Idempotency | SHA256 hash dedup on SQS |
| Database Sharding | DynamoDB partition by store_id |
| Load Balancing | ALB across AZs |
| Observability | CloudWatch metrics + structured logs |

# Sales Tracker — System Architecture Diagrams

## Diagram 1: Complete Request Flow with Multi-AZ Boundaries

```mermaid
flowchart TB
    subgraph STORES["🏪 200 Store POS Terminals"]
        S1["Store 001\nX-Store-API-Key: sk-001"]
        S2["Store 002\nX-Store-API-Key: sk-002"]
        SN["Store N...\nX-Store-API-Key: sk-N"]
    end

    subgraph EDGE["AWS Edge / Security Layer"]
        WAF["AWS WAF\nBlocks missing API key header\nPre-filters malformed requests"]
        ALB["Application Load Balancer\nTLS termination :443  |  ACM cert\nMulti-AZ  |  Health check: /health/ready\nFree tier: 750 hrs/mo (t2.micro equiv)"]
    end

    subgraph VPC["VPC — Private Subnets (us-east-1a / 1b / 1c)"]

        subgraph AZ_A["Availability Zone: us-east-1a"]
            NODE_A["t3.micro Node\n1 vCPU · 1 GB RAM"]
            API_A["API Pod\nsales-tracker\nPOST /sales handler\nEnqueues to SQS → 202"]
            CON_A["Consumer Pod\nsales-consumer\nSQS long-poll → DynamoDB PutItem"]
        end

        subgraph AZ_B["Availability Zone: us-east-1b"]
            NODE_B["t3.micro Node\n1 vCPU · 1 GB RAM"]
            API_B["API Pod\nsales-tracker"]
            CON_B["Consumer Pod\nsales-consumer"]
        end

        subgraph AZ_C["Availability Zone: us-east-1c"]
            NODE_C["t3.micro Node\n1 vCPU · 1 GB RAM"]
            API_C["API Pod\nsales-tracker"]
            CON_C["Consumer Pod\nsales-consumer"]
        end

        KEDA["KEDA Operator\nPolls SQS ApproximateNumberOfMessagesVisible\nevery 15 s  |  queueLength target: 50 msgs/pod\nminReplicas: 0  ·  maxReplicas: 50"]
    end

    subgraph AWS_MANAGED["AWS Managed Services"]
        SQS_Q["SQS Standard Queue\nsales-ingestion\nUnlimited throughput\nMessage retention: 4 days\n⚑ Durability guarantee point"]
        DLQ["SQS Dead Letter Queue\nsales-ingestion-dlq\nmaxReceiveCount: 3\nAlarm: any message → PagerDuty"]
        DDB["DynamoDB\nOn-Demand capacity\nPK: store_id#shard  SK: sale_id\nEncryption at rest (SSE)\nTTL: 90 days  |  PITR: enabled"]
    end

    subgraph SUPPORT["Supporting AWS Services"]
        SM["Secrets Manager\n200 store API keys\nAuto-rotation enabled"]
        CW["CloudWatch\nMetrics · Logs · Alarms\nEnd-to-end trace_id correlation"]
        S3TF["S3 + DynamoDB\nTerraform remote state\nVersioned bucket  |  State lock table"]
        ECR["ECR\nsales-tracker:latest\nsales-consumer:latest"]
    end

    %% ── Happy path (numbered) ──────────────────────────────────────────
    S1 -->|"① HTTPS POST /sales\n{quantity, buyer, time}"| WAF
    S2 --> WAF
    SN --> WAF
    WAF -->|"② Valid requests only"| ALB
    ALB -->|"③ Round-robin across\nhealthy pods"| API_A
    ALB --> API_B
    ALB --> API_C
    API_A -->|"④ SendMessage\n(synchronous)\ntrace_id + store_id\nas message attrs"| SQS_Q
    API_B --> SQS_Q
    API_C --> SQS_Q
    SQS_Q -->|"⑤ 202 Accepted\n↑ only after SQS confirms\nenqueue — durability"| ALB

    SQS_Q -->|"⑥ ReceiveMessage\nlong-poll 20 s\nbatch up to 10"| CON_A
    SQS_Q --> CON_B
    SQS_Q --> CON_C
    CON_A -->|"⑦ PutItem\nattribute_not_exists(sale_id)\nconditional write"| DDB
    CON_B --> DDB
    CON_C --> DDB

    %% ── KEDA scaling ───────────────────────────────────────────────────
    SQS_Q -.->|"queue depth signal\nApproximateNumberOfMessages\nVisible"| KEDA
    KEDA -.->|"scale consumer\nDeployment replicas"| CON_A
    KEDA -.-> CON_B
    KEDA -.-> CON_C

    %% ── Failure / retry path ───────────────────────────────────────────
    SQS_Q -->|"⑧ After 3 failed\ndeliveries"| DLQ
    DLQ -->|"alarm fires"| CW

    %% ── Auth lookup ────────────────────────────────────────────────────
    API_A -.->|"API key → store_id\nlookup (cached)"| SM
    API_B -.-> SM
    API_C -.-> SM

    %% ── Observability ──────────────────────────────────────────────────
    API_A -.->|"structured logs\ntrace_id"| CW
    CON_A -.-> CW
    DDB -.->|"consumed capacity\nmetrics"| CW
```

---

## Diagram 2: KEDA Autoscaling Trigger Sequence

```mermaid
sequenceDiagram
    participant POS as Store POS
    participant ALB as ALB
    participant API as API Pods (2-50)
    participant SQS as SQS Queue
    participant KEDA as KEDA Operator
    participant CON as Consumer Pods (0-50)
    participant DDB as DynamoDB

    Note over CON: minReplicas=0 → idle: 0 pods running

    POS->>ALB: HTTPS POST /sales (burst begins)
    ALB->>API: forward request
    API->>SQS: SendMessage (sync)
    SQS-->>API: MessageId confirmed
    API-->>ALB: 202 Accepted
    ALB-->>POS: 202 Accepted

    Note over SQS: Queue depth rising...

    KEDA->>SQS: GetQueueAttributes (every 15s)
    SQS-->>KEDA: ApproximateNumberOfMessagesVisible = 150

    Note over KEDA: 150 msgs / queueLength(50) = 3 pods needed

    KEDA->>CON: scale Deployment → replicas: 3
    Note over CON: Pod startup: ~30-60s cold start gap

    CON->>SQS: ReceiveMessage (long-poll, batch=10)
    SQS-->>CON: 10 messages
    CON->>DDB: PutItem (conditional, attribute_not_exists)
    DDB-->>CON: success
    CON->>SQS: DeleteMessage (batch)

    Note over SQS: Queue draining...

    KEDA->>SQS: GetQueueAttributes (next poll)
    SQS-->>KEDA: ApproximateNumberOfMessagesVisible = 0

    Note over KEDA: cooldownPeriod=60s then scale to 0

    KEDA->>CON: scale Deployment → replicas: 0
    Note over CON: Back to idle — zero cost
```

---

## Diagram 3: Failure Scenarios and Mitigations

```mermaid
flowchart LR
    subgraph FAILURES["Failure Scenarios"]
        F1["① API Pod crash"]
        F2["② Node failure\n(AZ event)"]
        F3["③ SQS unreachable\n(transient AWS fault)"]
        F4["④ DynamoDB\nwrite failure"]
        F5["⑤ Consumer\nprocessing poison pill"]
        F6["⑥ Burst spike\nexceeds API capacity"]
        F7["⑦ Duplicate\nPOS retry"]
    end

    subgraph MITIGATIONS["Mitigations (as designed)"]
        M1["PDB minAvailable=1\nRolling deploy maxUnavailable=0\nReadiness probe removes pod\nfrom ALB before kill"]
        M2["3 nodes across 3 AZs\nScheduleAnyway topology spread\nPod anti-affinity preferred\nEKS managed node group auto-repair"]
        M3["Readiness probe /health/ready\nchecks SQS reachability\nPod removed from ALB target\ngroup on failure"]
        M4["SQS message stays in-flight\n(visibility timeout)\nup to 3 retries\nthen → DLQ + alarm"]
        M5["maxReceiveCount=3 → DLQ\nCloudWatch alarm: DLQ depth > 0\nDead messages inspectable\nfor manual replay"]
        M6["SQS acts as buffer — API\nonly needs to enqueue (fast)\nKEDA scales consumers async\nSQS retention=4d absorbs spikes"]
        M7["SHA-256 hash of\nstore_id+buyer+qty+time\nas dedup key\nDynamoDB conditional write\nattribute_not_exists(sale_id)"]
    end

    F1 --- M1
    F2 --- M2
    F3 --- M3
    F4 --- M4
    F5 --- M5
    F6 --- M6
    F7 --- M7
```

---

## Diagram 4: Multi-AZ Topology and SPOF Elimination

```mermaid
flowchart TB
    subgraph REGION["AWS Region: us-east-1"]

        subgraph PUBLIC["Public Subnets (ALB)"]
            ALB_A["ALB Node\nus-east-1a"]
            ALB_B["ALB Node\nus-east-1b"]
            ALB_C["ALB Node\nus-east-1c"]
        end

        subgraph AZ1["Private Subnet — us-east-1a"]
            N1["Node: t3.micro"]
            P1["API Pod"]
            C1["Consumer Pod"]
        end

        subgraph AZ2["Private Subnet — us-east-1b"]
            N2["Node: t3.micro"]
            P2["API Pod"]
            C2["Consumer Pod"]
        end

        subgraph AZ3["Private Subnet — us-east-1c"]
            N3["Node: t3.micro"]
            P3["API Pod"]
            C3["Consumer Pod"]
        end

        subgraph GLOBAL["Regional / Global Services (no AZ SPOF)"]
            SQS2["SQS\n(regionally redundant)"]
            DDB2["DynamoDB\n(multi-AZ by default)"]
            SM2["Secrets Manager\n(regionally redundant)"]
            CW2["CloudWatch\n(regionally redundant)"]
        end
    end

    ALB_A --> N1
    ALB_B --> N2
    ALB_C --> N3

    N1 --> P1 & C1
    N2 --> P2 & C2
    N3 --> P3 & C3

    P1 & P2 & P3 --> SQS2
    C1 & C2 & C3 --> SQS2
    C1 & C2 & C3 --> DDB2
    P1 & P2 & P3 -.-> SM2
    P1 & P2 & P3 -.-> CW2
    C1 & C2 & C3 -.-> CW2
```

---

## Key Design Decisions at a Glance

| Layer | Component | Why chosen | Free tier limit |
|-------|-----------|------------|-----------------|
| Edge | ALB | Multi-AZ, health checks, TLS termination | 750 hrs/mo |
| Compute | EKS on t3.micro | Managed K8s, IRSA, auto-repair | 3 nodes = 3 × 750 hrs/mo |
| Buffer | SQS Standard | Unlimited throughput, 4-day retention | 1M requests/mo free |
| Scaling | KEDA on SQS depth | Right signal for I/O-bound consumer | Open source, no cost |
| Storage | DynamoDB on-demand | Serverless scale, SSE, PITR | 25 GB + 25 WCU free |
| Auth | Secrets Manager | Per-store rotation, IRSA integration | $0.40/secret/mo |
| Observability | CloudWatch | Native AWS, trace_id correlation | 10 custom metrics free |
| IaC state | S3 + DynamoDB | Versioned, locked, no SPOF | S3 5 GB free |

## Durability Guarantee Point

```
POST /sales received
        │
        ▼
   Validate payload
   Extract store_id from API key
   Compute SHA-256 dedup hash
        │
        ▼
   SQS SendMessage ◄─── 202 Accepted sent ONLY after this confirms
        │                    (SQS is the durability boundary)
        ▼
   Consumer polls asynchronously
        │
        ▼
   DynamoDB PutItem (conditional)
        │
        ├── Success → DeleteMessage from SQS
        ├── ConditionalCheckFailed (duplicate) → DeleteMessage (idempotent)
        └── Other error → Leave in-flight → retry → DLQ after 3 attempts
```

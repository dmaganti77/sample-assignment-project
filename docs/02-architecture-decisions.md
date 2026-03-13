# Architecture Decision Record — Sales Tracker

**Phase:** P — Plan (Infrastructure Agent)
**Date:** 2026-03-12
**Problem:** POST /sales API for 200 stores, 1–3,000,000 requests/hour on AWS EKS (free tier), IaC via Terraform.
**Input:** docs/01-exploration.md (Architect Agent exploration output)

---

## ADR-001: Message Queue as Durability Buffer (SQS Standard)

**Status:** Accepted

**Context:**
The exploration identified a fundamental tension: the API must return 2xx only after the write is durably persisted, but a synchronous database write on every request becomes both a bottleneck and a SPOF at 833 RPS. At that rate, with an estimated 5–50ms database write latency, the system would require 4–42 concurrent database connections per pod just to sustain throughput — and any database slowdown propagates directly into API latency and availability. Additionally, the 3,000,000x traffic variability means the write path must buffer flash bursts (estimated 9M+/hour during POS queue flush events) without dropping records.

**Decision:**
Insert Amazon SQS between the API pod and the DynamoDB consumer. The API pod writes to SQS synchronously and returns 2xx only after SQS confirms the message enqueue. A separate consumer pod reads from SQS and writes to DynamoDB. This decouples the API response latency from the database write latency.

SQS Standard Queue is chosen over FIFO Queue for the following reasons:

- **Throughput ceiling:** SQS FIFO is limited to 300 messages/second without batching, or 3,000 messages/second with batching. At 833 RPS sustained (and burst peaks above that), FIFO throughput headroom is insufficient without complex batching logic. SQS Standard has effectively unlimited throughput.
- **Ordering is not required:** Sales records are append-only and do not have ordering dependencies. A sale at 10:00:01 being stored before a sale at 10:00:00 from the same store has no correctness impact — both records will be present in DynamoDB with their original timestamps.
- **Deduplication is handled at the application layer:** SQS FIFO provides deduplication within a 5-minute window using a MessageDeduplicationId, but this requires exact-once semantics at the queue level which imposes the throughput limit. Instead, deduplication is applied at the DynamoDB write layer using a computed SHA-256 hash as the item's sort key. This decouples throughput from deduplication.
- **At-least-once delivery is acceptable:** SQS Standard provides at-least-once delivery. The system is designed for at-least-once semantics at all layers, with idempotent consumers handling rare duplicate deliveries.

A Dead Letter Queue (DLQ) is configured with maxReceiveCount=3. Messages that fail consumer processing three times are moved to the DLQ, triggering a CloudWatch alarm for immediate operator intervention.

**Durability guarantee:** SQS Standard stores messages redundantly across multiple AWS AZs. Once SQS returns a successful SendMessage response, the message is durably stored. The API pod does not return 2xx until this confirmation is received. This satisfies the "durability before acknowledgment" constraint from the exploration.

**Consequences:**
- The write path is now eventually consistent end-to-end: a 2xx response means the sale is durable in SQS, not yet in DynamoDB. The consumer introduces latency between queue ingestion and DynamoDB persistence (typically milliseconds to seconds under normal load).
- At-least-once delivery means the consumer must be idempotent. Rare duplicate SQS deliveries of the same message must not produce duplicate DynamoDB items.
- SQS Standard does not guarantee ordering. Analytics and reporting must not assume records arrive in DynamoDB in chronological order. Reporting queries must sort by the stored `sale_time` field, not by insertion order.
- SQS free tier: 1 million requests/month free. At 833 RPS sustained for a full month, monthly requests would be approximately 2.16 billion — well beyond the free tier. Cost at $0.40 per million requests beyond free tier must be budgeted for production peak. During idle periods (the dominant time distribution), SQS costs are negligible.

---

## ADR-002: DynamoDB as Primary Storage with Composite Partition Key

**Status:** Accepted

**Context:**
The exploration identified hot partition risk as a first-class challenge. A naive partition key of `store_id` concentrates writes on the 10 highest-volume stores (estimated 80% of traffic). DynamoDB throttles at the partition level, so hot partitions produce 429 errors even when aggregate table capacity is sufficient. Additionally, the `buyer` field contains PII, requiring encryption at rest.

**Decision:**
Use Amazon DynamoDB with on-demand capacity mode and the following key schema:

- **Partition key:** `store_id` — retains store locality for per-store queries, which are the dominant read pattern.
- **Sort key:** `sale_id` — a SHA-256 hash of `(store_id + buyer + quantity + sale_time)`, truncated to 16 hex characters and suffixed with a UUID. The UUID suffix ensures uniqueness even when hash collisions occur between genuinely different sales with identical field values. The SHA-256 prefix serves as the idempotency check: a conditional write with `attribute_not_exists(sale_id)` will reject a retry if the exact same hash has already been written.

**Hot partition mitigation strategy:**
DynamoDB automatically distributes data across internal partitions based on partition key. For the 10 high-volume stores that generate 80% of writes, the `store_id` partition will be split by DynamoDB's adaptive capacity feature (enabled by default on on-demand tables). Additionally, write sharding is applied: the consumer appends a shard suffix (`store_id#0` through `store_id#9`) selected by `hash(sale_id) mod 10`. A Global Secondary Index (GSI) on raw `store_id` allows per-store queries to fan out across shards and aggregate results. This distributes writes for hot stores across 10 sub-partitions.

**Capacity mode: On-demand** is chosen over provisioned for the following reasons:
- The 3,000,000x traffic variability makes provisioned capacity economically irrational. Provisioning for peak wastes money during the dominant idle periods. Provisioning for average means throttling during peaks.
- On-demand automatically scales read and write capacity units to match traffic without pre-specification.
- On-demand is covered by the DynamoDB free tier (25 GB storage, 25 write capacity units, 25 read capacity units — note these apply to provisioned; on-demand free tier is 25 GB storage + 2.5M read/write requests per month). Beyond the free tier, on-demand pricing applies.

**PII handling:**
DynamoDB encryption at rest is enabled using AWS-managed keys (SSE with DynamoDB-owned KMS key, no additional cost). This encrypts the `buyer` field at rest. In transit, all communication with DynamoDB uses HTTPS (enforced by AWS SDK defaults). For GDPR/CCPA right-to-erasure compliance, the composite key structure allows targeted deletion of individual records by `(store_id, sale_id)` without requiring a table scan.

**Consequences:**
- The GSI fan-out pattern adds read complexity. Per-store queries must query across up to 10 shard partitions and merge results in the application layer or via a Lambda/batch job.
- On-demand pricing at peak (833 RPS = 72M writes/day) will exceed the free tier substantially. Free tier covers 2.5M requests/month; peak sustained would consume that in under an hour. Production cost must be budgeted.
- Conditional writes for idempotency consume additional write capacity units (one additional read unit per conditional check). This is acceptable given the at-least-once delivery model and the rarity of actual duplicates.
- DynamoDB has a 400KB item size limit. Sales records at ~500 bytes are well within this limit.

---

## ADR-003: Networking — ALB with Multi-AZ and Per-Store Rate Limiting

**Status:** Accepted

**Context:**
The exploration identified the load balancer as SPOF 1 and single-AZ deployment as SPOF 4. A single load balancer instance or a load balancer deployed in one AZ cannot survive AZ-level failures. Additionally, per-store rate limiting is required to prevent a single misconfigured or malicious store from saturating the ingestion pipeline.

**Decision:**
Use AWS Application Load Balancer (ALB) deployed across all three AZs in the chosen region (us-east-1: us-east-1a, us-east-1b, us-east-1c).

- **Multi-AZ:** ALB inherently spans multiple AZs. It is not a single instance but a managed fleet distributed across the specified subnets. An AZ failure removes that AZ's ALB nodes from DNS, and Route 53 health checks reroute traffic to healthy AZs automatically.
- **ALB placement:** ALB is provisioned in public subnets (one public subnet per AZ). EKS worker nodes are in private subnets. The ALB forwards traffic to the Kubernetes Service (NodePort or via AWS Load Balancer Controller targeting pod IPs directly via target group binding). This maintains the principle that compute is not directly internet-accessible.
- **TLS termination:** The ALB terminates TLS. An ACM certificate is attached to the HTTPS listener (port 443). Internal ALB-to-pod traffic uses HTTP within the VPC private subnet, relying on VPC network controls rather than per-hop TLS, consistent with standard EKS ingress patterns.
- **Per-store rate limiting:** ALB does not natively support per-client rate limiting based on API key headers. Per-store rate limiting is enforced at the application layer within the API pod: each incoming request is authenticated (API key validated against cached Secrets Manager value), the store_id is derived from the key, and a token bucket rate limiter (in-memory, per-pod, seeded from a DynamoDB or ElastiCache counter for cross-pod coordination) enforces the per-store limit. The soft limit is 5,000 requests/hour per store (2x the average peak rate of 2,500 requests/hour/store at 3M/hour total). Stores exceeding this threshold receive HTTP 429. If full cross-pod rate limiting coordination is not implemented in phase one, the application enforces per-pod limits and accepts that a store can send up to (per-pod limit * num pods) before being throttled — an acceptable approximation at this scale.
- **DNS:** Route 53 is used for the API endpoint DNS record. ALB provides multiple IP addresses (one per AZ), and Route 53 returns all of them with low TTL (60 seconds). This provides DNS-level redundancy. Route 53 itself is a managed, globally distributed service with no single point of failure.

**Free tier:** ALB is free for the first 12 months (750 hours/month). ALB LCU (Load Balancer Capacity Units) may incur charges at high RPS, but for development and initial production at moderate traffic, this remains within or near free tier.

**Consequences:**
- TLS certificate management via ACM is required. ACM certificates are free but require domain validation. A registered domain is a prerequisite.
- Per-pod rate limiting without distributed coordination means a store can exceed its limit if requests are spread across many pods. This is a known limitation accepted in phase one, to be hardened with a distributed counter (Redis/ElastiCache) in a later iteration.
- Cross-AZ ALB traffic incurs $0.01/GB charges. At 200-byte average request payload at 833 RPS, cross-AZ data transfer is approximately 14 GB/day at peak — approximately $0.14/day, negligible for this use case.

---

## ADR-004: EKS Cluster Topology — Multi-AZ with t3.micro Nodes

**Status:** Accepted

**Context:**
The exploration identified single-node (SPOF 3) and single-AZ (SPOF 4) deployment as critical failure risks. EKS free tier provides 750 hours/month of t3.micro EC2 instances. The system must run on this constraint while maintaining the minimum viable redundancy.

**Decision:**
Deploy one Amazon EKS cluster in us-east-1 with the following topology:

**Node group configuration:**
- Single managed node group spanning three AZs: us-east-1a, us-east-1b, us-east-1c.
- Minimum node count: 3 (one per AZ). This eliminates single-AZ SPOF.
- Maximum node count: 9 (3 per AZ), supporting scale-out during sustained peak.
- Desired node count at steady state: 3.
- Instance type: t3.micro (1 vCPU, 1 GB RAM). This is the free-tier-eligible instance type (750 hrs/month free per account, covering up to ~1 t3.micro instance continuously).

**t3.micro vs t3.small tradeoff:**
t3.micro provides 1 vCPU and 1 GB RAM. After Kubernetes system components (kubelet, kube-proxy, containerd, AWS node agent) consume approximately 300–400 MB, roughly 600–700 MB is available for application pods. At peak load, this constrains pod count per node. t3.small (2 GB RAM) would provide more headroom but costs approximately $0.0208/hr beyond the free tier vs $0.0104/hr for t3.micro. For a system with long idle periods, t3.micro is the correct free-tier-constrained choice; scale-out adds more t3.micro nodes rather than scaling up instance size.

**Namespace structure:**
- `sales-api` — API pods (ingress path)
- `sales-consumer` — SQS consumer pods
- `keda` — KEDA operator and ScaledObject resources
- `monitoring` — CloudWatch agent daemonset, Prometheus scrape configs (if used)
- `kube-system` — Kubernetes system components (default)

**Pod placement:**
- API pods: minimum 2 replicas, anti-affinity rule `preferredDuringSchedulingIgnoredDuringExecution` with `topologyKey: topology.kubernetes.io/zone` to spread replicas across AZs. Hard anti-affinity (`requiredDuringScheduling`) would block scheduling if only 2 pods exist and 3 AZs are available — `preferred` is the correct setting to avoid scheduling deadlock while still encouraging spread.
- Consumer pods: minimum 2 replicas, same zone-spread anti-affinity.
- PodDisruptionBudget for API pods: `minAvailable: 1` — ensures at least one pod remains available during node drains, rolling deployments, or AZ failures.

**Consequences:**
- 3 t3.micro nodes exceed the free tier (750 hours/month covers approximately 1 full-time instance). Running 3 nodes continuously consumes 3x the free tier allocation. For a production free-tier project, scale-to-zero at the node level (using Cluster Autoscaler or Karpenter) during idle periods reduces cost, but EKS control plane charges ($0.10/hr = ~$73/month) remain fixed regardless of node count.
- t3.micro nodes with 1 GB RAM will OOM-kill pods if memory consumption spikes. Application pods must have memory limits set (recommended: 256Mi limit per API pod, 128Mi per consumer pod) to prevent runaway memory usage from destabilizing nodes.
- With 3 nodes and multiple system daemonsets, available capacity for application pods is limited. Node count must scale with replica count to avoid pod pending states.

---

## ADR-005: Autoscaling Strategy — KEDA on SQS Queue Depth

**Status:** Accepted

**Context:**
The exploration identified that standard HPA (Horizontal Pod Autoscaler) based on CPU utilization is an inadequate scaling signal for this workload. The core problem: CPU utilization on the API pod reflects current processing load, but the system's actual demand signal is the SQS queue depth. During a burst, the queue depth rises immediately while CPU may lag by 30–60 seconds as the HPA polling interval completes and new pods start. Additionally, during idle periods, the queue depth drops to zero and pods can be scaled to zero — something HPA cannot do because it requires at least 1 replica as the minimum.

**Why CPU-based HPA fails for this workload:**
1. The API pod's critical work is network I/O (SQS SendMessage), not CPU-bound computation. CPU utilization will remain low even under high throughput because the goroutines spend most of their time waiting for network responses. CPU never becomes the bottleneck.
2. The consumer pod's critical work is DynamoDB PutItem calls — again, network I/O, not CPU. A consumer pod at 100% of its throughput capacity may show only 10–20% CPU utilization.
3. HPA's minimum replica count of 1 means pods are always running, even when zero requests are arriving. This wastes $0.0104/hr in EC2 costs and consumes node memory during idle periods.
4. HPA's scale-up decision lag (metrics server polling every 15 seconds + HPA evaluation every 15 seconds + pod startup time of 30–60 seconds) results in a 60–90 second reaction window during which the queue accumulates. At 833 RPS, this means 50,000–75,000 requests queue up before new consumer pods are available.

**Decision: KEDA (Kubernetes Event-Driven Autoscaling) with SQS scaler.**

KEDA is deployed as a cluster-wide operator. A ScaledObject resource is created for the consumer deployment with the following parameters:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sales-consumer-scaler
  namespace: sales-consumer
spec:
  scaleTargetRef:
    name: sales-consumer
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 300
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: <SQS_QUEUE_URL>
        queueLength: "50"
        awsRegion: us-east-1
        identityOwner: operator
```

- `minReplicaCount: 0` — consumer scales to zero when queue is empty. No pods running during idle periods.
- `maxReplicaCount: 20` — 20 consumer pods at peak. Each consumer pod processes approximately 40–50 DynamoDB writes/second (limited by DynamoDB write latency and goroutine count), giving a maximum throughput of approximately 800–1000 writes/second — covering the 833 RPS maximum.
- `queueLength: 50` — KEDA scales up by one replica for every 50 messages in the queue. At 833 RPS with negligible processing latency, the queue depth will stabilize at (833 RPS * avg processing time) messages. This trigger ensures consumers keep pace with producers.
- `cooldownPeriod: 300` — 5-minute cooldown before scaling down, to prevent thrashing during bursty traffic that drops momentarily between waves.

**API pod autoscaling:**
The API pods (producer side) are scaled using HPA on memory utilization rather than CPU, with a minimum of 2 replicas:

```yaml
minReplicas: 2
maxReplicas: 10
metrics:
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70
```

API pods do not scale to zero because the ALB target group must have at least one healthy target registered. minReplicas=2 provides redundancy and avoids cold-start latency on first request.

**Scale-to-zero savings:**
During idle periods (the dominant time distribution, as identified in the exploration), consumer pods scale to zero within 5 minutes of the queue emptying. With 20 t3.micro consumer pods scaled down, the node count can also scale down via Cluster Autoscaler. The estimated idle savings: 17 consumer pods * $0.0104/hr = $0.177/hr, or approximately $128/month at continuous idle — meaningful savings given the EKS control plane $73/month fixed cost.

**Consequences:**
- KEDA requires deployment of the KEDA operator (two additional pods: keda-operator and keda-metrics-apiserver). These consume approximately 128MB of node memory and must be scheduled before any ScaledObjects become active.
- Scale-to-zero for consumers means a 30–60 second cold start delay when traffic resumes after an idle period. During this window, the SQS queue accumulates messages. This is acceptable because SQS durably holds messages; no data is lost during consumer cold start.
- KEDA's SQS scaler requires IAM permissions to call `sqs:GetQueueAttributes` to read queue depth. These permissions are granted to the KEDA operator service account via IRSA (IAM Roles for Service Accounts).
- KEDA is a third-party CNCF project. The team accepts a dependency on its continued maintenance and compatibility with the chosen EKS version.

---

## ADR-006: IAM Strategy — IRSA with Least-Privilege Per Service Account

**Status:** Accepted

**Context:**
The exploration identified centralized credential management as SPOF 9. Calling Secrets Manager on every request creates a performance bottleneck and a SPOF. Broad IAM permissions (e.g., a single EC2 instance role with full access to all AWS services) violate the principle of least privilege and create a blast radius risk if any pod is compromised.

**Decision:**
Use IRSA (IAM Roles for Service Accounts) to assign per-service-account IAM roles, scoped to the minimum required permissions.

**Service account to IAM role mapping:**

| Kubernetes Service Account | IAM Role | Permissions |
|---------------------------|----------|-------------|
| `sales-api-sa` (namespace: sales-api) | `sales-api-role` | `sqs:SendMessage` on the ingestion queue only; `secretsmanager:GetSecretValue` on the store credentials secret prefix only |
| `sales-consumer-sa` (namespace: sales-consumer) | `sales-consumer-role` | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` on the ingestion queue and DLQ; `dynamodb:PutItem`, `dynamodb:ConditionCheckItem` on the sales table only |
| `keda-operator-sa` (namespace: keda) | `keda-scaler-role` | `sqs:GetQueueAttributes` on the ingestion queue only (queue depth monitoring for scaling decisions) |

**IRSA implementation:**
- EKS OIDC provider is enabled for the cluster.
- Each IAM role has a trust policy that restricts assumption to the specific Kubernetes service account in the specific namespace.
- Pod specs reference the service account; the EKS Pod Identity Webhook injects the OIDC token as a projected volume and sets AWS SDK environment variables, enabling automatic credential exchange without any secrets stored in pod environment variables or Kubernetes Secrets.

**Secrets Manager for store credentials:**
Store API keys are stored in Secrets Manager, one secret per store, named `sales-tracker/store/{store_id}/api-key`. The API pod caches validated keys in an in-memory LRU cache with a 5-minute TTL. A cache hit requires zero Secrets Manager calls. A cache miss triggers a `GetSecretValue` API call. This eliminates the per-request Secrets Manager call that would create SPOF 9, while still enforcing immediate revocation within the 5-minute TTL window.

Secrets Manager vs SSM Parameter Store: Secrets Manager is chosen over SSM Parameter Store because:
- Secrets Manager supports automatic rotation natively, which is required for the 200-store credential rotation process.
- Secrets Manager has fine-grained IAM resource-level policies enabling per-secret access control.
- SSM Parameter Store with SecureString is an alternative at lower cost ($0.05/month per advanced parameter vs Secrets Manager at $0.40/secret/month), but lacks native rotation. At 200 stores, Secrets Manager costs $80/month for 200 secrets — a known cost accepted for the operational benefit of native rotation.

**Consequences:**
- IRSA requires the EKS OIDC provider to be configured as an identity provider in IAM. This is a one-time setup managed by the `iam` Terraform module.
- Changing a service account's permissions requires modifying the IAM role policy, not the Kubernetes manifest. This splits the permission model across two systems (Kubernetes RBAC for in-cluster access, IAM for AWS service access), which operators must understand.
- The 5-minute credential cache TTL means a revoked API key remains usable for up to 5 minutes. This is an accepted tradeoff for eliminating per-request Secrets Manager calls.

---

## ADR-007: Idempotency Architecture — SHA-256 Hash as Deduplication Key

**Status:** Accepted

**Context:**
The exploration identified that the API schema has no idempotency key. The payload is `{ "quantity": int, "buyer": string, "time": UTC }`. Store POS systems will retry failed or timed-out requests, and SQS delivers at-least-once, meaning the consumer may receive the same message more than once. Without idempotency controls, retries produce duplicate sale records — a correctness failure for financial data.

**Decision:**
Compute a SHA-256 hash of the canonical string `"{store_id}|{buyer}|{quantity}|{sale_time_iso8601}"` at the API layer before enqueuing. This hash serves two purposes:

1. **SQS message attribute:** The hash is included as an SQS message attribute `dedup_hash`. If the SQS message is delivered twice (at-least-once), the consumer uses the hash to perform a conditional DynamoDB write.
2. **DynamoDB conditional write:** The `sale_id` sort key is set to `{sha256_hash}#{uuid4}`. The consumer performs `PutItem` with condition `attribute_not_exists(sale_id_prefix)` — checking whether a record with this hash prefix already exists via a begins_with filter on a GSI. If the record already exists, the write is silently discarded (idempotent no-op). If not, the item is written. The UUID suffix ensures that two genuinely different sales with identical field values (e.g., same buyer buying the same quantity at the exact same second in the same store — highly unlikely but theoretically possible) are stored as distinct records, differentiated by UUID.

**Limitations of this approach:**
- Clock skew on the POS terminal's `time` field means a retried request sent with the same wall-clock time produces the same hash, correctly identified as a duplicate. However, a retry sent after a clock correction that changes the `time` field value will produce a different hash and be stored as a new (duplicate) record. This is an accepted limitation given the schema constraint.
- Two buyers with the exact same name purchasing the exact same quantity at the exact same second in the same store will produce the same hash. The UUID suffix prevents the second record from being discarded; instead, both records are stored (the UUID differentiates them). This is correct behavior — they are genuinely different sales.
- Hash collisions in SHA-256 are computationally negligible (collision probability is approximately 1 in 2^128 for any pair of inputs). This is not a practical concern.

**Consequences:**
- The conditional DynamoDB write consumes one additional read capacity unit per write (for the condition check). At 833 RPS, this doubles the read capacity consumption: 833 RCU/second at peak in addition to 833 WCU/second.
- The dedup hash must be computed at the API layer and included in the SQS message. The consumer must not recompute it, because the consumer may not have access to the original authenticated `store_id` unless it is included in the SQS message body.
- This approach does not provide exactly-once semantics. In the rare case where a DynamoDB conditional write fails after the SQS message is received but before it is deleted (consumer crash between write and delete), the message will be redelivered and the conditional write will correctly no-op. This is correct behavior.

---

## ADR-008: Terraform Remote State — S3 with DynamoDB Locking

**Status:** Accepted

**Context:**
The exploration identified local Terraform state as SPOF 7. Local state files cannot be safely shared across team members, are lost if the operator's machine fails, and cannot be locked to prevent concurrent applies that corrupt state.

**Decision:**
Use the standard Terraform S3 remote state backend:

- **S3 bucket:** `sales-tracker-tfstate-{account_id}` with versioning enabled and server-side encryption (SSE-S3). Versioning allows rollback to a previous state file if corruption occurs. The bucket is in the same AWS account and region as the infrastructure.
- **DynamoDB table:** `sales-tracker-tfstate-lock` with `LockID` as the partition key (string). Terraform uses this table for state locking: before any `terraform apply`, Terraform writes a lock record; on completion or failure, it deletes the lock. Concurrent applies by different operators fail with a lock error rather than producing a corrupted state file.
- **Bucket policy:** Denies all access except from the CI/CD role and the operator IAM users. Denies `s3:DeleteObject` to prevent accidental state deletion.
- **MFA delete:** Enabled on the S3 bucket to require multi-factor authentication for any object deletion — protecting against accidental or malicious state file deletion.

**S3 backend configuration in `versions.tf`:**
```hcl
terraform {
  backend "s3" {
    bucket         = "sales-tracker-tfstate-${var.account_id}"
    key            = "sales-tracker/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "sales-tracker-tfstate-lock"
    encrypt        = true
  }
}
```

Note: The S3 bucket and DynamoDB lock table must be bootstrapped before the main Terraform configuration can be initialized. A separate `bootstrap/` Terraform configuration (not included in the main module tree) creates these resources. This is a standard pattern for Terraform remote state.

**Consequences:**
- S3 state storage cost: negligible (a few KB of state files at $0.023/GB/month).
- DynamoDB lock table cost: on-demand pricing; lock/unlock operations are two writes per apply — negligible cost.
- State file contains sensitive values (ARNs, configuration parameters). The SSE-S3 encryption and restrictive bucket policy address this risk for most threat models. For higher security requirements, SSE-KMS with a customer-managed key should be used (adds KMS API call costs).
- The bootstrap step (creating S3 and DynamoDB before main infrastructure) must be documented in the operations runbook. New team members must bootstrap before running the main plan.

---

## ADR-009: Observability — CloudWatch with Full Write Path Coverage

**Status:** Accepted

**Context:**
The exploration identified the observability gap as a critical risk: at 833 RPS, silent drops of 1% of writes result in 28,800 lost records per hour, undetectable without metrics spanning the full write path. The monitoring pipeline itself is SPOF 10 — if monitoring fails silently, operators have no visibility into system health.

**Decision:**
Use CloudWatch for all metrics and alarms, structured logging, and the Container Insights agent for EKS pod-level metrics. CloudWatch is chosen over a self-hosted Prometheus/Grafana stack because:
- CloudWatch is managed with no operational overhead.
- CloudWatch Logs, Metrics, and Alarms are independent services with their own redundancy — the monitoring pipeline does not share failure modes with the application pipeline.
- Free tier: 10 custom metrics, 5 GB log ingestion/month, 10 alarms. The system uses fewer than 10 custom metrics in phase one, keeping costs within free tier.

**Metrics and alarms:**

| Metric | Source | Alarm Condition | Consequence |
|--------|--------|-----------------|-------------|
| `SQS/ApproximateNumberOfMessagesVisible` (ingestion queue) | AWS/SQS (built-in) | > 10,000 messages for 5 minutes | Consumer pods not keeping pace; scale or investigate |
| `SQS/ApproximateNumberOfMessagesVisible` (DLQ) | AWS/SQS (built-in) | > 0 messages | Immediate alert — consumer is failing to process messages |
| `SQS/NumberOfMessagesSent` (ingestion queue) | AWS/SQS (built-in) | Drops to 0 for > 10 minutes during business hours | API pods may be down or ALB unhealthy |
| `DynamoDB/SuccessfulRequestLatency` (PutItem) | AWS/DynamoDB (built-in) | p99 > 100ms | DynamoDB write latency degrading |
| `DynamoDB/SystemErrors` | AWS/DynamoDB (built-in) | > 0 for 5 minutes | DynamoDB internal errors; escalate |
| `sales_api_write_success_rate` | Custom (emitted by API pod) | < 99.9% for 5 minutes | API-to-SQS write failures |
| `sales_consumer_write_success_rate` | Custom (emitted by consumer pod) | < 99.9% for 5 minutes | Consumer-to-DynamoDB write failures |
| `sales_e2e_latency_p99` | Custom (computed from SQS enqueue timestamp vs DynamoDB write timestamp) | > 30 seconds | End-to-end write pipeline is backed up |

**Custom metric implementation:**
API pods and consumer pods emit custom metrics via the CloudWatch Embedded Metric Format (EMF). EMF allows structured log lines to be parsed by CloudWatch Logs into metrics without separate PutMetricData API calls. This approach does not count against the 10 custom metric alarm limit for the metrics themselves (EMF metrics are charged per metric, but the structured log lines are emitted via the standard log group, already within the 5 GB log ingestion free tier for low-volume environments).

**Structured logging:**
All pods emit JSON-structured logs to stdout. The CloudWatch Container Insights agent (deployed as a DaemonSet) ships logs to CloudWatch Logs. Each log entry includes:
- `timestamp` (RFC3339)
- `level` (info/warn/error)
- `store_id` (from authenticated context — enables per-store log filtering)
- `trace_id` (UUID generated at API ingress, passed through SQS message attributes to consumer — enables end-to-end correlation)
- `component` (api/consumer)
- `event` (specific event name: `sale_received`, `sqs_enqueued`, `sqs_received`, `dynamodb_written`, `dynamodb_duplicate_rejected`, `dlq_moved`)

The `trace_id` propagation from API pod to SQS message to consumer pod is the key mechanism for closing the observability gap: an operator can search CloudWatch Logs for a specific `trace_id` and see the complete lifecycle of a single sale record from receipt to DynamoDB storage.

**Monitoring pipeline redundancy:**
CloudWatch itself is an AWS-managed service with no operator-managed SPOF. The Container Insights agent DaemonSet runs on every node; if one node fails, its agent fails but agents on other nodes continue shipping. CloudWatch Alarms notify via SNS → email/PagerDuty. The SNS topic has multiple subscriptions to prevent a single delivery failure from silently dropping an alert.

**Consequences:**
- CloudWatch custom metrics are charged at $0.30/metric/month after the 10-metric free tier. The 8 metrics in the table above exceed the free tier by 0 (6 of the 8 are built-in AWS/SQS and AWS/DynamoDB metrics, which are not custom metrics). Only `sales_api_write_success_rate`, `sales_consumer_write_success_rate`, and `sales_e2e_latency_p99` are custom metrics — 3 total, within the 10-metric free tier.
- Log ingestion at 833 RPS with one log line per event and two log lines per request (API enqueue + consumer write) = 1,666 log lines/second at peak. At an average of 200 bytes per log line, this is 333 KB/second = 28 GB/day at peak. This significantly exceeds the 5 GB/month free tier. Log filtering (setting log level to WARN in production except for error paths) and sampling (logging 1% of successful writes at INFO level) are required to stay near free tier.
- The `trace_id` correlation approach requires the API pod to include the `trace_id` in the SQS message attributes, and the consumer to read and log it. This is an application-level convention that must be specified in the backend agent handoff.

---

## ADR-010: Security Architecture — TLS, PII, and Store Credential Isolation

**Status:** Accepted

**Context:**
The exploration identified three security challenges: unauthorized writes (200 untrusted store clients), PII in the `buyer` field, and volumetric abuse. The authentication layer is also the source of `store_id`, making it load-bearing for business logic, not just security.

**Decision:**
The security architecture has four layers:

**Layer 1 — Transport Security:**
All external traffic uses TLS 1.2+ terminated at the ALB (ACM certificate). Internal VPC traffic (ALB to EKS pods, pods to SQS, pods to DynamoDB, pods to Secrets Manager) uses HTTPS enforced by the AWS SDK and the Load Balancer Controller's target group configuration. No plaintext HTTP is permitted on any path that carries sale data or credentials.

**Layer 2 — Store Authentication:**
Each store has one API key, stored as a Secrets Manager secret at path `sales-tracker/store/{store_id}/api-key`. The API key is a 256-bit random hex string generated at store onboarding. The key is passed as an HTTP header `X-Store-API-Key`. The API pod validates the key against the cached Secrets Manager value (5-minute LRU cache, as described in ADR-006). The `store_id` is derived from the secret path — not from any client-supplied value. A client cannot claim to be a different store by modifying its request; the store identity is determined solely by the API key.

ALB listener rule pre-check: A WAF rule on the ALB rejects any request missing the `X-Store-API-Key` header before it reaches the EKS pod, reducing load from unauthenticated noise traffic.

**Layer 3 — Input Validation:**
The API handler enforces the following constraints before enqueuing to SQS:
- `quantity`: integer, 1 ≤ quantity ≤ 10,000 (business-logic bounds; rejects obvious misconfiguration)
- `buyer`: string, 1–255 characters, UTF-8 encoded; control characters stripped
- `time`: ISO 8601 UTC timestamp; rejected if more than 24 hours in the past or 5 minutes in the future (clock skew tolerance window)
- `Content-Type: application/json` required; other content types rejected

**Layer 4 — PII Handling:**
The `buyer` field is PII. At-rest encryption is provided by DynamoDB SSE (AWS-managed key). In transit, TLS protects the field at every hop. For GDPR/CCPA right-to-erasure, the composite key `(store_id#shard, sale_id)` allows targeted deletion of individual records without table scans. A future enhancement (outside this ADR's scope) is to encrypt the `buyer` field at the application layer with a per-store KMS key, enabling key-level deletion (deleting the KMS key renders all records for that store unreadable without deleting DynamoDB items). This application-layer encryption is deferred to a later phase.

**Rate limiting enforcement:**
Per-store rate limiting is enforced at the API pod layer (token bucket, 5,000 requests/hour per store, in-memory per-pod). Stores exceeding the limit receive `HTTP 429 Too Many Requests` with a `Retry-After` header set to the number of seconds until the next token is available. The store client's retry logic must respect this header; without it, aggressive retries worsen the load. ALB access logs provide the source IP for abuse pattern analysis.

**Consequences:**
- WAF on the ALB adds cost ($5/month base + $1/million requests). This may push costs above free tier. The WAF rule for missing API key header is a simple, low-cost rule; the WAF is optional in phase one and can be added after initial deployment.
- Per-pod token bucket rate limiting without cross-pod coordination means that as API pod count scales from 2 to 10, the effective per-store limit scales proportionally (from 10,000 to 50,000 requests/hour with 10 pods). This is a known approximation; a distributed rate limiter (Redis or DynamoDB counter) is the production-grade solution.
- Application-layer PII encryption (KMS-per-store) is deferred. In the interim, DynamoDB SSE is the sole at-rest protection for the `buyer` field.

---

## System Architecture Summary

### Complete Data Flow

```
                            ┌─────────────────────────────────────────┐
                            │         AWS us-east-1                   │
                            │                                         │
  200 Store                 │  ┌─────────────────────────────────┐    │
  POS Terminals             │  │  Application Load Balancer      │    │
  (HTTPS)                   │  │  (public subnets, 3 AZs)        │    │
       │                    │  │  TLS termination, WAF pre-check │    │
       └──────────────────► │  └──────────────┬──────────────────┘    │
                            │                 │ HTTP                  │
                            │  ┌──────────────▼──────────────────┐    │
                            │  │  EKS Private Subnets (3 AZs)    │    │
                            │  │                                  │    │
                            │  │  ┌─────────────────────────┐    │    │
                            │  │  │  API Pods (2–10 replicas)│    │    │
                            │  │  │  Namespace: sales-api   │    │    │
                            │  │  │  1. Validate API key     │    │    │
                            │  │  │  2. Derive store_id      │    │    │
                            │  │  │  3. Validate input       │    │    │
                            │  │  │  4. Compute SHA-256 hash │    │    │
                            │  │  │  5. SendMessage → SQS    │    │    │
                            │  │  │  6. Return 202 Accepted  │    │    │
                            │  │  └───────────┬─────────────┘    │    │
                            │  │              │ IRSA (sqs:SendMessage)│ │
                            │  └─────────────-│──────────────────┘    │
                            │                 │                        │
                            │  ┌──────────────▼──────────────────┐    │
                            │  │  Amazon SQS Standard Queue      │    │
                            │  │  (multi-AZ managed, durable)    │    │
                            │  │  MessageDeduplicationId: hash   │    │
                            │  │  VisibilityTimeout: 30s         │    │
                            │  │  MessageRetentionPeriod: 4 days │    │
                            │  │         │  DLQ (maxReceive=3)   │    │
                            │  └─────────┼────────────────────────┘   │
                            │            │                             │
                            │  ┌─────────▼────────────────────────┐   │
                            │  │  Consumer Pods (0–20 replicas)   │   │
                            │  │  Namespace: sales-consumer       │   │
                            │  │  KEDA ScaledObject (queueLen=50) │   │
                            │  │  1. ReceiveMessage from SQS      │   │
                            │  │  2. Conditional PutItem → DDB    │   │
                            │  │     (attribute_not_exists check) │   │
                            │  │  3. DeleteMessage from SQS       │   │
                            │  │  4. Emit e2e success metric      │   │
                            │  └───────────────┬──────────────────┘   │
                            │                  │ IRSA (dynamodb:PutItem)│
                            │  ┌───────────────▼──────────────────┐   │
                            │  │  Amazon DynamoDB (on-demand)     │   │
                            │  │  PK: store_id#shard (0–9)        │   │
                            │  │  SK: sha256_hash#uuid4           │   │
                            │  │  SSE: AWS-managed key            │   │
                            │  │  GSI: store_id (for queries)     │   │
                            │  └──────────────────────────────────┘   │
                            │                                         │
                            │  ┌──────────────────────────────────┐   │
                            │  │  CloudWatch (observability)      │   │
                            │  │  - Container Insights DaemonSet  │   │
                            │  │  - Structured JSON logs          │   │
                            │  │  - trace_id: API → SQS → DDB     │   │
                            │  │  - DLQ depth alarm (> 0 = alert) │   │
                            │  └──────────────────────────────────┘   │
                            │                                         │
                            │  ┌──────────────────────────────────┐   │
                            │  │  S3 + DynamoDB (Terraform state) │   │
                            │  │  Versioned, encrypted, locked    │   │
                            │  └──────────────────────────────────┘   │
                            └─────────────────────────────────────────┘

Durability guarantee point: SQS SendMessage success (step 5 in API pod)
202 Accepted sent: immediately after SQS confirms enqueue
DynamoDB write: asynchronous, seconds to minutes after 202
```

### SPOF Resolution Table

| SPOF (from exploration) | Resolution |
|-------------------------|------------|
| Single load balancer | ALB spans 3 AZs; managed fleet, not a single instance |
| Single API pod | minReplicas=2, zone anti-affinity, PDB minAvailable=1 |
| Single Kubernetes node | 3 nodes minimum, one per AZ, Cluster Autoscaler |
| Single AZ deployment | Multi-AZ subnets for nodes, ALB, and SQS |
| Synchronous DB on hot path | SQS buffers writes; DynamoDB write is async |
| Single message queue | SQS is a managed multi-AZ service internally |
| Local Terraform state | S3 remote backend with DynamoDB locking |
| DNS single point | Route 53 with multi-IP ALB records, 60s TTL |
| Central secrets store per-request | 5-minute LRU cache; Secrets Manager called on cache miss only |
| Monitoring pipeline SPOF | CloudWatch is managed, multi-AZ; independent of app pipeline |

### AWS Services Map

| Service | Role | Free Tier Limit |
|---------|------|-----------------|
| EKS (control plane) | Kubernetes cluster management | $0.10/hr fixed — no free tier |
| EC2 t3.micro | EKS worker nodes (3–9 nodes) | 750 hrs/month (~1 node continuously) |
| ALB | Public HTTPS ingress, TLS termination | 750 hrs/month (first 12 months) |
| SQS Standard | Durable write buffer between API and consumer | 1M requests/month free |
| SQS DLQ | Failed message capture and alerting | Included in SQS free tier |
| DynamoDB (on-demand) | Primary storage for sale records | 25 GB storage; 2.5M req/month |
| Secrets Manager | Store API key storage with rotation | $0.40/secret/month (no free tier) |
| S3 | Terraform remote state | 5 GB storage free (first 12 months) |
| DynamoDB (tfstate lock) | Terraform state locking | Included in DynamoDB free tier |
| CloudWatch Logs | Structured application logs | 5 GB ingestion/month free |
| CloudWatch Metrics | Built-in SQS/DynamoDB metrics + 3 custom | 10 custom metrics free |
| CloudWatch Alarms | DLQ depth, write success rate, latency | 10 alarms free |
| Route 53 | DNS for API endpoint | $0.50/hosted zone/month |
| ACM | TLS certificate for ALB | Free (public certificates) |
| IAM (IRSA) | Per-service-account least-privilege roles | Free |

### Terraform Module Ownership Table

| Module | Path | Key Resources Managed |
|--------|------|-----------------------|
| `vpc` | `terraform/modules/vpc/` | VPC, 3 public subnets (ALB), 3 private subnets (EKS nodes), Internet Gateway, NAT Gateway (one per AZ for private subnet egress), route tables, VPC flow logs |
| `eks` | `terraform/modules/eks/` | EKS cluster, managed node group (t3.micro, 3–9 nodes), OIDC provider, aws-load-balancer-controller Helm release, KEDA Helm release, Cluster Autoscaler Helm release |
| `iam` | `terraform/modules/iam/` | IRSA trust policies, `sales-api-role`, `sales-consumer-role`, `keda-scaler-role`; OIDC provider association; Secrets Manager IAM policies |
| `sqs` | `terraform/modules/sqs/` | Ingestion SQS Standard queue, DLQ, queue policy, redrive policy (maxReceiveCount=3), SQS queue CloudWatch alarms |
| `dynamodb` | `terraform/modules/dynamodb/` | Sales table (on-demand, SSE enabled), GSI on store_id, Terraform state lock table |
| `secrets` | `terraform/modules/secrets/` | Secrets Manager secrets for 200 store API keys (one per store), resource policy restricting access to `sales-api-role` |
| `s3` | `terraform/modules/s3/` | Terraform state S3 bucket (versioning, SSE-S3, MFA delete, restrictive bucket policy) |

### Terraform Module Structure

```
terraform/
├── main.tf              # Module orchestration: calls all modules, passes outputs between them
├── variables.tf         # Input variables: region, account_id, cluster_name, store_count, environment
├── outputs.tf           # Output values: EKS cluster endpoint, SQS queue URLs, DynamoDB table name
├── versions.tf          # Provider versions (aws ~> 5.0, helm ~> 2.0, kubernetes ~> 2.0) + S3 backend config
└── modules/
    ├── vpc/
    │   ├── main.tf      # aws_vpc, aws_subnet (6 total), aws_internet_gateway, aws_nat_gateway (3),
    │   │                #   aws_route_table, aws_route_table_association
    │   ├── variables.tf # vpc_cidr, azs, public_subnet_cidrs, private_subnet_cidrs
    │   └── outputs.tf   # vpc_id, public_subnet_ids, private_subnet_ids
    ├── eks/
    │   ├── main.tf      # aws_eks_cluster, aws_eks_node_group, aws_iam_openid_connect_provider,
    │   │                #   helm_release (aws-load-balancer-controller, keda, cluster-autoscaler)
    │   ├── variables.tf # cluster_name, k8s_version, node_instance_type, min/max/desired_nodes,
    │   │                #   private_subnet_ids, vpc_id
    │   └── outputs.tf   # cluster_endpoint, cluster_name, oidc_provider_arn, node_group_arn
    ├── iam/
    │   ├── main.tf      # aws_iam_role (3 IRSA roles), aws_iam_policy (per-role least-privilege),
    │   │                #   aws_iam_role_policy_attachment
    │   ├── variables.tf # oidc_provider_arn, sqs_queue_arn, sqs_dlq_arn, dynamodb_table_arn,
    │   │                #   secrets_manager_prefix
    │   └── outputs.tf   # sales_api_role_arn, sales_consumer_role_arn, keda_scaler_role_arn
    ├── sqs/
    │   ├── main.tf      # aws_sqs_queue (ingestion + DLQ), aws_sqs_queue_redrive_policy,
    │   │                #   aws_cloudwatch_metric_alarm (DLQ depth, queue depth)
    │   ├── variables.tf # queue_name, visibility_timeout_seconds, message_retention_seconds,
    │   │                #   dlq_max_receive_count, alarm_sns_topic_arn
    │   └── outputs.tf   # queue_url, queue_arn, dlq_url, dlq_arn
    ├── dynamodb/
    │   ├── main.tf      # aws_dynamodb_table (sales, on-demand, SSE, GSI), aws_dynamodb_table
    │   │                #   (tfstate lock), aws_cloudwatch_metric_alarm (latency, errors)
    │   ├── variables.tf # table_name, billing_mode, hash_key, range_key, gsi_name
    │   └── outputs.tf   # table_name, table_arn, table_stream_arn
    ├── secrets/
    │   ├── main.tf      # aws_secretsmanager_secret (one per store, created via count/for_each),
    │   │                #   aws_secretsmanager_secret_version (initial placeholder value),
    │   │                #   aws_secretsmanager_secret_policy (restrict to sales-api-role)
    │   ├── variables.tf # store_ids (list of 200 store IDs), api_role_arn
    │   └── outputs.tf   # secret_arns (map of store_id → secret ARN)
    └── s3/
        ├── main.tf      # aws_s3_bucket (tfstate), aws_s3_bucket_versioning,
        │                #   aws_s3_bucket_server_side_encryption_configuration,
        │                #   aws_s3_bucket_public_access_block, aws_s3_bucket_policy
        ├── variables.tf # bucket_name, account_id
        └── outputs.tf   # bucket_id, bucket_arn
```

---

## Handoff to Backend Agent

The Backend Agent must implement the following components to satisfy this infrastructure plan:

### Go Application Requirements (`app/`)

**API pod (`cmd/main.go`, `internal/handler/sales.go`):**
1. HTTP server on port 8080, graceful shutdown with 30-second timeout (to drain in-flight requests during pod termination).
2. Single endpoint: `POST /sales`. Reject all other paths with 404.
3. Readiness probe endpoint: `GET /healthz` returning 200 when the SQS client is initialized and the Secrets Manager cache is populated. Liveness probe: `GET /livez` returning 200 always (process is alive).
4. Request handling sequence:
   a. Extract `X-Store-API-Key` header. Reject with 401 if missing.
   b. Validate key against Secrets Manager LRU cache (5-minute TTL, max 250 entries). On cache miss, call `secretsmanager:GetSecretValue`. Reject with 401 if key is invalid.
   c. Derive `store_id` from the secret name (path segment after `sales-tracker/store/`).
   d. Check per-store token bucket rate limiter (5,000 tokens/hour per store). Reject with 429 if exhausted.
   e. Decode JSON body. Reject with 400 if malformed.
   f. Validate fields: quantity (1–10,000), buyer (1–255 chars), time (parseable ISO 8601, within ±24hr of server time).
   g. Compute SHA-256 hash of `"{store_id}|{buyer}|{quantity}|{time_utc_iso8601}"`.
   h. Build SQS message body (JSON): `{"store_id": ..., "buyer": ..., "quantity": ..., "sale_time": ..., "received_at": ..., "dedup_hash": ..., "trace_id": <uuid4>}`.
   i. Call `sqs:SendMessage` with the JSON body. On error, return 503. On success, return 202.
   j. Emit CloudWatch EMF log line: `{"_aws": {"Timestamp": ..., "CloudWatchMetrics": [{"Namespace": "SalesTracker", "Dimensions": [["component"]], "Metrics": [{"Name": "WriteSuccess", "Unit": "Count"}]}]}, "component": "api", "WriteSuccess": 1, "store_id": ..., "trace_id": ...}`.

**Consumer pod (`internal/queue/sqs.go`):**
1. Long-poll SQS (`WaitTimeSeconds=20`, `MaxNumberOfMessages=10`) in a loop.
2. For each message:
   a. Unmarshal JSON body.
   b. Extract `dedup_hash` and `trace_id`.
   c. Call `dynamodb:PutItem` with condition `attribute_not_exists(#sk)` where `#sk` is the sort key. Sort key value: `{dedup_hash}#{uuid4}` (generate new UUID per attempt).
   d. If condition fails (duplicate), log `dynamodb_duplicate_rejected` at INFO and proceed to delete.
   e. If PutItem succeeds, log `dynamodb_written` at INFO with `trace_id`.
   f. Call `sqs:DeleteMessage`. On failure, log error but do not panic — the message will be redelivered.
   g. Emit CloudWatch EMF metric: `WriteSuccess` and `e2eLatencyMs` (computed as `time.Now() - message.SentTimestamp`).
3. On PutItem error (non-conditional): do not delete the message. Let visibility timeout expire and SQS redeliver. After 3 failures, SQS moves to DLQ.

**DynamoDB item schema:**
```
PK:  store_id#shard    (e.g., "store_042#7" where shard = hash(dedup_hash) mod 10)
SK:  dedup_hash#uuid4  (e.g., "a3f9b2c1d4e5f678#550e8400-e29b-41d4-a716-446655440000")
Attributes:
  store_id:     string (raw, unsharded, for GSI lookup)
  buyer:        string
  quantity:     number
  sale_time:    string (ISO 8601 UTC, from POS terminal)
  received_at:  string (ISO 8601 UTC, server-side ingestion timestamp from API pod)
  trace_id:     string (UUID, for log correlation)
  dedup_hash:   string (SHA-256 prefix, for conditional write check)
```

**Go module (`app/go.mod`):**
- `aws-sdk-go-v2` for SQS, DynamoDB, and Secrets Manager clients.
- `github.com/google/uuid` for UUID generation.
- Standard library only for HTTP, JSON, hashing, rate limiting.

### Kubernetes Manifest Requirements (`k8s/`)

1. `deployment.yaml` — API deployment: 2 replicas, resource limits (CPU: 500m, memory: 256Mi), `X-Store-API-Key` header forwarding, env vars for SQS URL and AWS region sourced from ConfigMap, service account annotation for IRSA role ARN.
2. `deployment-consumer.yaml` — Consumer deployment: 0 replicas initial (KEDA manages), resource limits (CPU: 250m, memory: 128Mi), same IRSA pattern.
3. `service.yaml` — ClusterIP service for API pods targeting port 8080.
4. `ingress.yaml` — Kubernetes Ingress using `kubernetes.io/ingress.class: alb`, targeting the API service, with ALB annotations for HTTPS listener, ACM certificate ARN, and target group health check path `/healthz`.
5. `keda-scaledobject.yaml` — ScaledObject as specified in ADR-005, targeting the consumer deployment.
6. `hpa.yaml` — HPA for API deployment: minReplicas=2, maxReplicas=10, target memory utilization 70%.
7. `pdb.yaml` — PodDisruptionBudget for API deployment: minAvailable=1.
8. `configmap.yaml` — ConfigMap in sales-api and sales-consumer namespaces with SQS queue URL, DynamoDB table name, AWS region, and log level.

### Environment Variables the Application Must Read

| Variable | Source | Used By |
|----------|--------|---------|
| `SQS_QUEUE_URL` | ConfigMap | API pod (SendMessage) |
| `DYNAMODB_TABLE_NAME` | ConfigMap | Consumer pod (PutItem) |
| `AWS_REGION` | ConfigMap | Both pods (SDK region config) |
| `LOG_LEVEL` | ConfigMap | Both pods |
| `RATE_LIMIT_PER_STORE_PER_HOUR` | ConfigMap | API pod (token bucket seed) |
| `SECRETS_CACHE_TTL_SECONDS` | ConfigMap | API pod (LRU cache TTL) |
| `AWS_ROLE_ARN` | Pod annotation (IRSA) | Both pods (injected by EKS webhook) |
| `AWS_WEB_IDENTITY_TOKEN_FILE` | Pod annotation (IRSA) | Both pods (injected by EKS webhook) |

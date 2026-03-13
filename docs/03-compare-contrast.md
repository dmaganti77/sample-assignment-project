# Sales Tracker — Compare & Contrast Analysis

**Phase:** C — Compare (Reviewer Agent)
**Date:** 2026-03-13
**Reviewer:** Principal SRE (10+ years distributed systems production experience)
**Input:** docs/01-exploration.md, docs/02-architecture-decisions.md, all files under app/, k8s/, terraform/

---

## Section 1: What Each Agent Got Right

### Architect Agent (docs/01-exploration.md)

**SPOF enumeration is thorough and correct.** The agent identified all 10 SPOFs including the Terraform state SPOF (SPOF 7) and the secret store performance SPOF (SPOF 9) — two that most design documents miss entirely. The explicit table at the end of the document is the right artifact.

**CAP theorem analysis is accurate and honest.** The agent correctly chose AP and explicitly documented what is sacrificed: a write acknowledged by one replica during a partition could be lost before replication. It did not hide this risk. The narrow carve-out for deduplication consistency is also correct (docs/01-exploration.md, section "Where Strong Consistency IS Required").

**Hot partition risk is correctly identified and quantified.** The Pareto distribution observation — 10 of 200 stores generating 80% of traffic — is realistic and grounded. The agent correctly identified that time-based partitioning shifts the problem rather than solving it (docs/01-exploration.md, section "Hot Partition Risk").

**PII and compliance risks are identified.** The `buyer` field as PII, GDPR right-to-erasure implications, and the coupling between authentication and `store_id` derivation are all called out correctly.

**Scale-up lag is quantified.** The 1–3 minute HPA reaction window at 833 RPS producing 50,000–100,000 queued requests during cold start is a concrete, useful number (docs/01-exploration.md, section "Burst Characteristics").

**The API schema gap is correctly identified as a root cause.** The absence of an idempotency key in `{ "quantity": int, "buyer": string, "time": UTC }` is flagged as a "fundamental schema design problem" rather than an implementation detail. This is correct — all downstream complexity (SHA-256 dedup, conditional writes, DLQ handling) flows from this single schema gap.

---

### Infrastructure Agent (docs/02-architecture-decisions.md)

**SQS Standard over FIFO is the correct choice and the reasoning is sound.** ADR-001 correctly identifies the 300 msg/s FIFO throughput ceiling as a disqualifier for 833 RPS sustained traffic and documents that deduplication is shifted to the consumer layer. This is the right call and the ADR documents the tradeoff honestly.

**DLQ is configured and the Terraform SQS module actually implements it.** terraform/modules/sqs/main.tf creates both `aws_sqs_queue.dlq` and `aws_sqs_queue.main` with a `redrive_policy`. This is one area where the ADR and the implementation are aligned.

**DynamoDB on-demand mode is correct for this traffic profile.** ADR-002 correctly states that provisioning for peak wastes money during the dominant idle periods, and that provisioning for average causes throttling during peaks. On-demand mode with DynamoDB adaptive capacity is the right answer.

**TTL for record expiry is implemented end-to-end.** The `expires_at` field is set in app/internal/consumer/dynamodb.go (line 187: `90 * 24 * time.Hour`) and the TTL attribute is configured in terraform/modules/dynamodb/main.tf (lines 41–44). This chain is complete and consistent.

**DynamoDB point-in-time recovery is enabled.** terraform/modules/dynamodb/main.tf lines 46–48 enable PITR. This directly addresses the backup gap and is the correct free-tier-compatible choice.

**IRSA architecture is correct.** ADR-006 describes per-service-account roles with least-privilege scoping. The consumer and API service accounts are created separately (k8s/consumer-serviceaccount.yaml, k8s/manifests.yaml). This is a production-correct pattern.

**SQS visibility timeout mismatch is partially mitigated.** The Terraform module sets `visibility_timeout_seconds = 300` (terraform/modules/sqs/main.tf line 11) as a queue-level fallback while the consumer overrides it per-receive-call to 30 seconds (app/internal/consumer/dynamodb.go line 24). The ADR comment justifying 300 seconds as "6x consumer processing time" is coherent as a fallback; having both values is better than neither.

**CloudWatch observability coverage spans the full write path.** ADR-009's metric table covers SQS ingestion, DLQ depth, DynamoDB write latency, API success rate, and consumer success rate. Critically, `sales_e2e_latency_p99` is specified as a custom metric measuring the gap between SQS enqueue and DynamoDB write — exactly the observability gap the architect identified.

**Structured logging with trace_id propagation is implemented correctly.** The trace_id is generated at app/internal/handler/sales.go line 25, passed as an SQS message attribute (app/internal/queue/sqs.go lines 58–62), and extracted at the consumer (app/internal/consumer/dynamodb.go lines 223–228). The chain is complete.

**Graceful shutdown is implemented in both binaries.** app/cmd/main.go (lines 52–73) uses `signal.Notify` with a 15-second shutdown context. app/cmd/consumer/main.go (lines 58–67) uses `signal.NotifyContext`. Both are correct patterns.

**API server timeouts are configured.** app/cmd/main.go sets `ReadTimeout: 5s`, `WriteTimeout: 10s`, `IdleTimeout: 60s` — preventing slowloris attacks and connection leaks.

---

### Backend Agent (app/, k8s/)

**The Dockerfile correctly uses a multi-stage scratch build.** The scratch base image for the runtime stage eliminates the OS attack surface entirely. The non-root UID (65534) and the CA certificates copy are correct.

**The handler returns 202 Accepted, not 200 OK.** app/internal/handler/sales.go line 75 returns `http.StatusAccepted`. This is semantically correct: the sale is queued, not yet persisted. Returning 200 would imply the write is complete.

**Input validation is complete and correct.** app/internal/models/sale.go validates quantity bounds (1–10,000), buyer length (1–255), RFC3339 timestamp format, and the ±24-hour clock skew window. All four constraints from ADR-010 Layer 3 are implemented.

**Idempotent consumer correctly handles ConditionalCheckFailedException.** app/internal/consumer/dynamodb.go lines 141–153: a `ConditionalCheckFailedException` is treated as a successful dedup (the record already exists) and the SQS message is deleted. Non-conditional errors leave the message in-flight for retry. This is the correct pattern.

**The consumer handles nil message bodies and unparseable JSON without infinite looping.** Lines 111–131 in dynamodb.go delete malformed messages rather than leaving them to loop until maxReceiveCount. This prevents DLQ pollution from permanently unprocessable messages.

**SQS long-polling is correctly configured.** `waitTimeSeconds = 20` in the consumer reduces empty-receive API calls, which is both cost-effective and the correct production configuration for SQS.

**Security context is hardened consistently.** Both deployments set `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `runAsNonRoot: true`, `runAsUser: 65534`, and drop all capabilities. The namespace has Pod Security Standards set to `restricted` (k8s/manifests.yaml lines 76–79).

**PodDisruptionBudget is configured.** k8s/manifests.yaml lines 47–57 set `minAvailable: 1` for the API deployment. This prevents complete API outage during node drains.

**topologySpreadConstraints with `whenUnsatisfiable: ScheduleAnyway` is the correct choice.** A hard anti-affinity rule would cause scheduling deadlock when fewer zones are available than replicas; the `ScheduleAnyway` soft constraint is the right production default.

---

## Section 2: What Each Agent Missed or Oversimplified

### Architect Agent Gaps

**Cold-start latency for scale-to-zero was not identified.** The exploration mentions scale-up lag for HPA (1–3 minutes) but never addresses the specific failure mode of KEDA's cold-start path from zero pods. When consumer pods are at zero and a burst arrives: KEDA polls every 15 seconds (pollingInterval in keda-scaledobject.yaml line 19), then detects queue depth, then Kubernetes schedules the pod (image pull, container start: 30–60 seconds on a cold node). Total gap: 45–75 seconds during which SQS accumulates messages with zero consumers. At 833 RPS, that is 37,000–62,500 unprocessed messages. SQS durably holds them, so no data is lost, but the exploration should have identified this as a latency SLA risk — the system will show multi-minute write-to-storage lag during every scale-up event.

**SQS visibility timeout vs. consumer processing time mismatch was not identified.** The consumer sets `visibilityTimeout = 30` seconds per receive call (app/internal/consumer/dynamodb.go line 24). If a DynamoDB write takes longer than 30 seconds (throttled, slow, or retrying), the message becomes visible again and a second consumer picks it up. This creates a race condition: two consumers could both successfully attempt to write the same record before either deletes the SQS message. The conditional write handles correctness, but the consumer does not implement `ChangeMessageVisibility` to extend the timeout for long-running messages. This class of problem was never raised in the exploration.

**The SHA-256 dedup collision scenario is more subtle than acknowledged.** The exploration correctly identified that two buyers with the same name purchasing the same quantity at the same second in the same store produce the same hash. But a more operationally common case: a store retries after a network timeout during which the store's clock ticks forward by one second. The timestamp changes, the hash changes, and both records are stored. The exploration acknowledged this as "an accepted limitation" but did not specify the operational impact: duplicate records are expected and undetectable post-hoc during any partial connectivity event.

**The DynamoDB conditional write thundering herd was not identified.** When SQS delivers a burst of messages after a cold start — say 500 messages arriving at once — all consumer pods simultaneously attempt conditional PutItem writes. Each conditional write requires a read capacity unit. At 50 consumer pods each processing 10 messages concurrently, a hot partition on a single store_id can exhaust DynamoDB's internal partition capacity even in on-demand mode. DynamoDB's adaptive capacity has a ramp-up period; it does not instantly provision unlimited capacity. The exploration identified hot partition risk generally but missed this specific thundering-herd pattern at the conditional-write level.

**ALB connection draining vs. terminationGracePeriodSeconds mismatch was not identified.** The API deployment sets `terminationGracePeriodSeconds: 30` (k8s/deployment.yaml line 25). When a pod is terminated, the ALB continues routing requests to the pod's IP for up to the ALB deregistration delay (default: 300 seconds) unless the annotation `alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=30` is explicitly set. Without this annotation, a pod receives new requests for up to 5 minutes after receiving SIGTERM while the Go server's 15-second shutdown (app/cmd/main.go line 66) stops accepting connections at second 15. Requests arriving between second 15 and second 300 get connection refused. The Ingress (k8s/manifests.yaml) has no `deregistration_delay` annotation. This is a data loss path during every rolling deployment.

**Topology spread behavior during rolling deployments under AZ degradation was not addressed.** With 2 API pods and `maxUnavailable: 0, maxSurge: 1` (k8s/deployment.yaml lines 17–18), the surge pod brings the total to 3. If a node in one AZ is unavailable, the scheduler falls back to `ScheduleAnyway` and may place both old and new pods in one AZ — eliminating the AZ redundancy the topology constraint was designed to provide. The exploration said nothing about this rollback failure mode.

---

### Infrastructure Agent Gaps

**ADR-001 chose SQS Standard, but the architecture diagram still shows `MessageDeduplicationId: hash` in the SQS queue box.** `MessageDeduplicationId` is a FIFO-only field. Its presence in the ADR's ASCII diagram for a Standard queue is incorrect. The backend agent correctly omitted it from the implementation (app/internal/queue/sqs.go line 44 explicitly notes this), but the ADR itself contains a contradictory artifact that would mislead anyone reading the document without the code.

**ADR-002 specifies write sharding (`store_id#0` through `store_id#9`) but the implementation does not implement it — and goes further by omitting the partition key entirely.** ADR-002 states: "write sharding is applied: the consumer appends a shard suffix (`store_id#0` through `store_id#9`) selected by `hash(sale_id) mod 10`." The DynamoDB table uses `hash_key = "store_id"` in terraform/modules/dynamodb/main.tf (line 9). The consumer's `writeToDynamoDB` in app/internal/consumer/dynamodb.go builds the item map (lines 189–196) with `sale_id`, `buyer`, `quantity`, `sale_time`, `created_at`, and `expires_at` — but no `store_id` field. DynamoDB's PutItem requires all key attributes to be present in the item. Every write will fail with `ValidationException: Missing the key store_id`. The ADR specified write sharding; the code does not write the basic unsharded partition key. The ADR-to-code translation is broken at the most fundamental level.

**ADR-005 says `maxReplicaCount: 20` but the actual manifest uses `maxReplicaCount: 50`.** At 50 consumer pods, each requiring at minimum 100m CPU and 128Mi RAM, the total demand is 5 vCPU and 6.4 GB RAM for consumers alone. With `node_max_size = 3` t3.micro nodes (terraform/variables.tf line 43), each providing approximately 600 MB usable RAM after system overhead, the cluster can schedule approximately 10–12 consumer pods maximum. The `maxReplicaCount: 50` value in keda-scaledobject.yaml (line 16) is physically unschedulable given the Terraform node constraints. KEDA would attempt to scale to 50, pods would remain Pending, and the queue would continue growing unbounded.

**The ADR specifies Secrets Manager validation but the implementation bypasses it entirely.** ADR-006 describes a 5-minute LRU cache validated against Secrets Manager, with `store_id` derived from the secret path — "not from any client-supplied value." The actual handler (app/internal/handler/sales.go line 28) does `storeID := r.Header.Get("X-Store-API-Key")` and uses the raw header value directly as `store_id` with no Secrets Manager call, no key validation, and no path-based derivation. Any string is a valid store_id. A client sending `X-Store-API-Key: injected_value` will write to a DynamoDB partition named `injected_value`. This is a complete authentication bypass.

**The ADR specifies per-store token bucket rate limiting but it is not implemented.** ADR-003 and ADR-010 both specify "token bucket, 5,000 requests/hour per store, in-memory per-pod." The handler (app/internal/handler/sales.go) has no rate limiting code, no 429 response path, and no Retry-After header. Any store can send unlimited requests.

**The ADR says the SQS module includes CloudWatch alarms but the actual module has none.** The Terraform module ownership table in the ADR states the SQS module manages "SQS queue CloudWatch alarms." terraform/modules/sqs/main.tf contains no `aws_cloudwatch_metric_alarm` resources — only the queue, DLQ, and redrive policy. No DLQ depth alarm exists despite being central to ADR-009's observability plan.

**The ADR describes 7 Terraform modules but only 2 exist on disk.** The ADR's module structure table lists `vpc`, `eks`, `iam`, `sqs`, `dynamodb`, `secrets`, and `s3` modules. The actual terraform/modules/ directory contains only `sqs/` and `dynamodb/`. The `vpc`, `eks`, `iam`, `secrets`, and `s3` modules are referenced in terraform/main.tf but do not exist. A `terraform init` followed by `terraform plan` will fail immediately with "module source not found" for all five missing modules. The infrastructure cannot be deployed.

**The remote state backend is commented out.** terraform/versions.tf lines 19–26 have the S3 backend configuration commented out with the comment "Uncomment for remote state (recommended)." ADR-008 is an accepted ADR specifying remote state. The implementation left it commented. Any `terraform apply` against this configuration uses local state, recreating the exact SPOF-7 the ADR was written to eliminate.

**ECR is not in the Terraform plan at all.** The container images referenced in k8s/deployment.yaml (line 38) and k8s/consumer-deployment.yaml (line 41) use ECR image URIs. There is no `aws_ecr_repository` resource in any Terraform module. Without ECR repos, the Kubernetes deployments fail with `ImagePullBackOff` immediately on first deploy.

---

### Backend Agent Gaps

**The DynamoDB PutItem call is missing the partition key — every write will fail.** app/internal/consumer/dynamodb.go, the `item` map at lines 189–196, contains: `sale_id`, `buyer`, `quantity`, `sale_time`, `created_at`, `expires_at`. The DynamoDB table's partition key is `store_id` (terraform/modules/dynamodb/main.tf line 9). DynamoDB's PutItem requires all key attributes to be present in the item. Every write fails with: `ValidationException: One or more parameter values were invalid: Missing the key store_id in the item`. The consumer logs the error, leaves the message in-flight, waits 30 seconds for the visibility timeout, and retries — until maxReceiveCount=3 is reached, at which point all messages move to the DLQ. In production, this means zero records ever reach DynamoDB.

**There is no go.sum file.** The Dockerfile (line 7) does `COPY go.mod go.sum ./`. The app/ directory contains only `go.mod`. The Docker build fails at the COPY instruction with "file not found." No container image can be built. No deployment can proceed. This is a blocking build failure that makes every Kubernetes manifest irrelevant until resolved.

**The handler uses the raw API key header value as store_id with no validation.** app/internal/handler/sales.go line 28 reads `storeID := r.Header.Get("X-Store-API-Key")` and uses this directly as the `store_id` in the dedup hash and in all structured log fields. Any arbitrary string submitted as the header becomes a valid store_id and a valid DynamoDB partition key. The entire authentication architecture from ADR-006 and ADR-010 was not implemented.

**The consumer does not implement visibility timeout extension for slow DynamoDB writes.** `visibilityTimeout = 30` seconds is set on each ReceiveMessage call (app/internal/consumer/dynamodb.go line 24). There is no `ChangeMessageVisibility` call anywhere in the consumer code. Under DynamoDB throttling, a write can exceed 30 seconds, the message becomes visible to other consumers, and two pods race to write the same record. The conditional write ensures correctness, but this produces unnecessary duplicate write attempts and DynamoDB capacity consumption.

**The exec liveness probe `kill -0 1` does not work in a scratch container.** k8s/consumer-deployment.yaml lines 44–50 define a liveness probe: `command: ["/bin/sh", "-c", "kill -0 1"]`. A scratch container has no shell — `scratch` contains only the compiled binary, no `/bin/sh`. This probe will always fail with `exec: "/bin/sh": stat /bin/sh: no such file or directory`. Kubernetes will repeatedly fail the liveness probe, declare the pod unhealthy, and restart it in a crash loop. No consumer pod can run in production with this probe.

**The KEDA ScaledObject `valuesFrom` syntax is not valid KEDA API for the SQS trigger.** keda-scaledobject.yaml lines 33–37 use a `valuesFrom` field at the trigger level to read the queue URL from a ConfigMap. The KEDA SQS trigger does not support `valuesFrom` at the trigger metadata level. ConfigMap injection for trigger parameters requires a `TriggerAuthentication` resource with `configMapTargetRef`. As written, `queueURL` in the metadata block is an empty string (`queueURL: ""`), and the `valuesFrom` block is silently ignored by the KEDA operator. KEDA polls an empty URL and fails. The consumer never scales.

**The consumer binary has no Dockerfile.** app/Dockerfile line 14 builds `./cmd/main.go` (the API server). There is no separate Dockerfile for the consumer at `./cmd/consumer/main.go`. k8s/consumer-deployment.yaml (line 41) references `sales-consumer:latest`, but no build instruction produces this image. The consumer image cannot be built from the repository as delivered.

---

## Compare & Contrast Table

| Area | LLM Agent Output | Production Reality | Gap Severity |
|------|-----------------|-------------------|--------------|
| Authentication | Raw API key header used as store_id with no Secrets Manager lookup (handler/sales.go:28) | Key validated against Secrets Manager, store_id derived from secret path, LRU-cached | HIGH |
| DynamoDB writes | PutItem missing `store_id` partition key — every write fails with ValidationException | All key attributes present in every PutItem | HIGH (blocking) |
| Docker build | go.sum missing; Dockerfile line 7 fails | go.sum committed, reproducible build | HIGH (blocking) |
| Consumer Dockerfile | No Dockerfile for cmd/consumer/main.go | Separate Dockerfile or multi-binary build | HIGH (blocking) |
| Terraform modules | 5 of 7 modules referenced but missing from disk | All modules present; terraform init succeeds | HIGH (blocking) |
| KEDA queueURL | Empty string; valuesFrom is not valid KEDA SQS trigger syntax | Correct queue URL in metadata or valid TriggerAuthentication | HIGH |
| Consumer liveness probe | /bin/sh not present in scratch container; probe always fails | File-based probe or no probe with process exit monitoring | HIGH |
| Rate limiting | Not implemented; any store can send unlimited requests | Token bucket per store at API layer; 429 with Retry-After | HIGH |
| Remote state | S3 backend block commented out; uses local state | Backend block active; state in versioned S3 + DynamoDB lock | HIGH |
| ECR repositories | Not in any Terraform module | aws_ecr_repository for both images | HIGH |
| Write sharding | ADR specifies store_id#shard suffix; code omits even bare store_id | Shard suffix computed as hash(sale_id) mod 10 | HIGH |
| CloudWatch alarms | Not in SQS Terraform module despite ADR claim | aws_cloudwatch_metric_alarm for DLQ depth, queue depth | MED |
| ALB deregistration delay | No annotation; 5-min default causes requests to terminating pods | alb.ingress.kubernetes.io/target-group-attributes annotation set to 30s | MED |
| KEDA maxReplicaCount vs node capacity | maxReplicaCount=50 unschedulable on node_max_size=3 t3.micro | maxReplicaCount bounded by node capacity; Cluster Autoscaler configured | MED |
| ALB access logs | Not configured in Ingress annotations | access_logs.s3.enabled annotation + S3 bucket | MED |
| Network policy | No NetworkPolicy; unrestricted pod-to-pod traffic | NetworkPolicy for API (SQS egress only) and consumer (SQS+DynamoDB egress) | MED |
| Visibility timeout extension | No ChangeMessageVisibility for long writes | ChangeMessageVisibility called when processing time > 2/3 of timeout | MED |
| DLQ alarm | DLQ exists in Terraform; no alarm wired to SNS | aws_cloudwatch_metric_alarm on DLQ depth > 0 | MED |
| CI/CD pipeline | None | Build, test, push, deploy pipeline for both images | MED |
| Secrets rotation | ADR specifies rotation; no Lambda or schedule exists | aws_secretsmanager_secret_rotation with dual-validity window | MED |
| KEDA cold start | 45–75s gap acknowledged in ADR but no mitigation | minReplicaCount=1 during business hours (cron-based scaling) | MED |
| Multi-environment | Single environment variable; no workspaces or tfvars | Separate workspaces with tfvars per environment | MED |
| Load testing | No load test exists | k6 or locust test validating 3M req/hr at staging | MED |
| SLOs | Not defined | API availability %, p99 write latency, DLQ depth = 0 | MED |
| EKS version pinning | Not in any variable | kubernetes_version pinned in EKS module | LOW |
| Cross-region backup | PITR enabled; no cross-region copy or restore test | DynamoDB Global Tables or S3 export with restore test | LOW |
| Cost alerting | No budget alarms | aws_budgets_budget with SNS at 80% and 100% | LOW |
| ECR image scanning | Not configured | scan_on_push = true; HIGH/CRITICAL CVEs block deploy | LOW |
| Topology spread under AZ failure | Not analyzed | Documented behavior; runbook for degraded AZ scenario | LOW |
| PII application-layer encryption | Deferred in ADR-002 | Per-store KMS key for buyer field; key deletion = erasure | LOW |

---

## Section 3: Free Tier vs Production Reality Gap Analysis

**1. No CI/CD Pipeline**
- Free tier design: Agents designed application code, Kubernetes manifests, and Terraform modules. No deployment pipeline exists. Manifests contain placeholder values (`<ECR_ACCOUNT>`, `<ACCOUNT_ID>`, `$(ACM_CERT_ARN)`) that must be substituted before apply.
- Production reality: Every code change requires: `go test`, `docker build`, ECR push, manifest substitution, `kubectl apply` or Helm upgrade, smoke test in staging, then prod promotion. Without a pipeline, deployments are manual, untested, and dependent on individual operator knowledge.
- Risk if not closed: A developer manually applying k8s/manifests.yaml with un-substituted placeholders creates broken Kubernetes resources. The first production deployment fails.

**2. No Container Registry (ECR)**
- Free tier design: k8s/deployment.yaml (line 38) and k8s/consumer-deployment.yaml (line 41) reference ECR image URIs. No `aws_ecr_repository` resource exists in any Terraform module.
- Production reality: Two ECR repositories must exist before any Kubernetes deployment can succeed. The node group IAM role also needs `ecr:GetAuthorizationToken` and `ecr:BatchGetImage` permissions.
- Risk if not closed: All pods fail with `ImagePullBackOff` on first deploy. The system is undeployable.

**3. No Secrets Rotation**
- Free tier design: ADR-006 mentions Secrets Manager supports automatic rotation. No rotation Lambda, rotation schedule, or `aws_secretsmanager_secret_rotation` resource exists in any Terraform module.
- Production reality: Rotating a compromised store credential requires a Lambda that generates a new key, a dual-validity window where old and new keys are accepted simultaneously, and a completion step that invalidates the old key. The 5-minute LRU cache adds a further complication during rotation.
- Risk if not closed: A compromised store credential cannot be rotated without a service interruption. Manual rotation across 200 stores at scale is operationally infeasible.

**4. No Multi-Environment Strategy**
- Free tier design: terraform/variables.tf has an `environment` variable (line 7–11) with default "dev." No workspace configurations, no per-environment tfvars files, no module input differences between dev and prod.
- Production reality: Dev, staging, and prod require separate state files, separate AWS accounts or VPCs, and separate DynamoDB tables to prevent prod data contamination.
- Risk if not closed: A developer running `terraform apply` without workspace isolation can overwrite prod infrastructure with dev parameters.

**5. No Backup Strategy Beyond PITR**
- Free tier design: DynamoDB PITR is enabled in terraform/modules/dynamodb/main.tf (lines 46–48). This is the only backup mechanism and has never been restore-tested.
- Production reality: PITR allows point-in-time restore but requires manual execution. There is no automated restore test, no cross-region backup, and no defined RTO/RPO. At 36 GB/day peak ingestion, an untested restore process is an unacceptable risk for financial data.
- Risk if not closed: A table-level corruption or accidental deletion requires a manual restore process with unknown mean time to recovery.

**6. No Cost Alerting**
- Free tier design: No `aws_budgets_budget` or cost-related CloudWatch alarm exists. ADR-001 documents that 833 RPS sustained for a month generates approximately 2.16 billion SQS requests at $0.40/million — approximately $864/month from SQS alone. This fact is documented and then ignored.
- Production reality: AWS Budget alarms with SNS notification at 80% and 100% of monthly budget thresholds are table stakes. A consumer bug that re-enqueues messages creates an infinite loop consuming unlimited SQS capacity.
- Risk if not closed: A runaway consumer bug generates thousands of dollars in unexpected charges before anyone notices.

**7. SQS DLQ — Created, Not Monitored**
- Free tier design: The DLQ is correctly created in terraform/modules/sqs/main.tf (lines 4–7) with 14-day retention and a redrive policy (lines 15–18). There is no `aws_cloudwatch_metric_alarm` for DLQ depth in the module.
- Production reality: A DLQ with no alarm is a silent graveyard. The entire point of a DLQ is to trigger an alert when messages cannot be processed.
- Risk if not closed: Consumer failures move messages to the DLQ silently. An operator discovers the failure 14 days later when records are missing from DynamoDB reports.

**8. ALB Access Logs Not Configured**
- Free tier design: k8s/manifests.yaml defines the Ingress with ALB annotations (lines 21–27). No `access_logs.s3.enabled` annotation is present.
- Production reality: ALB access logs are the only record of which store IPs sent requests, what HTTP status codes were returned, and what the request latency distribution looked like. For a system handling financial transactions from 200 untrusted clients, access logs are a compliance requirement.
- Risk if not closed: A store disputes a failed transaction. Without ALB logs, there is no evidence of whether the request was received or what response was returned.

**9. No Kubernetes NetworkPolicy**
- Free tier design: The namespace has Pod Security Standards set to `restricted` (k8s/manifests.yaml lines 76–79). No `NetworkPolicy` resources exist anywhere in the k8s/ directory.
- Production reality: Without NetworkPolicy, any pod in the `sales` namespace can initiate connections to any other pod, including lateral movement by a compromised pod using another pod's IRSA credentials.
- Risk if not closed: A compromised API pod can directly query DynamoDB, bypass the SQS queue, or make unauthorized AWS API calls using the consumer's IRSA token.

**10. t3.micro Node Limits vs. maxReplicaCount: 50**
- Free tier design: variables.tf sets `node_instance_type = "t3.micro"` and `node_max_size = 3`. keda-scaledobject.yaml sets `maxReplicaCount: 50`.
- Production reality: Three t3.micro nodes with approximately 600 MB usable RAM each provide approximately 1.8 GB total. After 2 API pods (256 MB each) and system pods, approximately 10 consumer pod slots remain. KEDA targeting 50 replicas leaves 40 pods Pending indefinitely.
- Risk if not closed: Under peak load, the system reaches approximately 20% of designed consumer throughput. Queue depth grows unbounded. Messages expire after 1 day (terraform/modules/sqs/main.tf line 13: `message_retention_seconds = 86400`). Sale records are permanently lost.

**11. EKS Version Not Pinned**
- Free tier design: The EKS module does not exist on disk. No EKS version variable appears in variables.tf.
- Production reality: Without pinning `cluster_version`, AWS provisions the latest available EKS version. Minor EKS upgrades can change API group versions, deprecate resources, and break KEDA compatibility.
- Risk if not closed: AWS auto-upgrades the control plane during a maintenance window. The upgrade breaks KEDA. The consumer stops scaling. Queue depth grows unbounded until manually remediated.

**12. go.sum Missing — Docker Build Fails**
- Free tier design: app/Dockerfile line 7: `COPY go.mod go.sum ./`. The app/ directory contains only `go.mod`. No `go.sum` exists.
- Production reality: `go.sum` is generated by `go mod tidy` and must be committed. Without it, `docker build` fails on the COPY instruction. No image can be produced.
- Risk if not closed: The first `docker build` on any machine fails. No CI/CD pipeline can produce an image. No Kubernetes pod can start.

**13. No Graceful Consumer Shutdown Under KEDA Scale-Down**
- Free tier design: app/cmd/consumer/main.go uses `signal.NotifyContext` (line 58) to handle SIGTERM. `terminationGracePeriodSeconds: 30` allows 30 seconds before SIGKILL.
- Production reality: When KEDA scales down a consumer pod, the `Run` loop blocks for up to 20 seconds on the current long-poll (`waitTimeSeconds = 20`) before checking `ctx.Done()`. With 20-second long-poll plus message processing time, the pod may be SIGKILL'd mid-batch, leaving processed messages undeleted and triggering SQS redelivery after the visibility timeout expires.
- Risk if not closed: Not a data correctness risk (idempotency handles it), but every scale-down event produces a burst of duplicate SQS deliveries and unnecessary DynamoDB conditional check overhead.

**14. KEDA Cold Start Gap**
- Free tier design: keda-scaledobject.yaml sets `pollingInterval: 15` and `cooldownPeriod: 60`. The ADR acknowledges "30–60 second cold start delay" (ADR-005 Consequences).
- Production reality: Full cold start timeline: KEDA detects queue at next poll (0–15s) + pod scheduled and started on existing warm node (5–10s) + image pull on cold node (10–60s) + container start (1–3s). Worst case if a new node must be provisioned: 15 + 180 + 60 + 3 = 258 seconds. At 833 RPS over 4 minutes, 200,000 messages queue before the first consumer is ready.
- Risk if not closed: A predictable daily cold start at store opening produces a 4-minute gap in DynamoDB write latency every morning. Reconciliation jobs expecting near-real-time data miss these records.

---

## Section 4: Day 2 SRE Operations Checklist

### P0 — Must Fix Before Any Production Traffic

- [ ] **Fix the missing `store_id` in DynamoDB PutItem** (app/internal/consumer/dynamodb.go lines 189–196). The `item` map must include `"store_id"` as an `AttributeValueMemberS`. The `store_id` must be passed through the SQS message body (it is not currently included — app/internal/queue/sqs.go only marshals the `Sale` struct). Until fixed, every DynamoDB write fails with `ValidationException` and every message moves to the DLQ.

- [ ] **Generate and commit go.sum.** Run `go mod tidy` in the `app/` directory and commit `app/go.sum`. Without this file, the Dockerfile line 7 COPY instruction fails and no image can be built. Every downstream step in this project depends on this file existing.

- [ ] **Create a consumer Dockerfile.** app/Dockerfile builds `./cmd/main.go` only. A separate Dockerfile (or a multi-binary Dockerfile using build targets) must produce the `sales-consumer` image for `./cmd/consumer/main.go`. k8s/consumer-deployment.yaml references this image; without it no consumer pod can start.

- [ ] **Create ECR repositories in Terraform.** Add `aws_ecr_repository` resources for `sales-tracker` and `sales-consumer`. Add the required IAM policy (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`) to the node group role. Without ECR repos, every Kubernetes pod fails with `ImagePullBackOff`.

- [ ] **Fix the consumer liveness probe.** k8s/consumer-deployment.yaml lines 44–50: `kill -0 1` requires `/bin/sh` which does not exist in a scratch container. Replace with a file-based probe (consumer writes a heartbeat file on each successful poll; probe checks modification time with a max-age threshold) or remove the liveness probe and rely on the process exit code.

- [ ] **Fix the KEDA ScaledObject queueURL.** keda-scaledobject.yaml line 28: `queueURL: ""`. The `valuesFrom` block at lines 33–37 is not valid KEDA SQS trigger syntax. Replace with the actual queue URL value, or use a TriggerAuthentication with `configMapTargetRef`. Until fixed, KEDA polls an empty URL and the consumer never scales.

- [ ] **Implement Secrets Manager authentication in the handler.** app/internal/handler/sales.go lines 28–32: the handler accepts any non-empty string as a valid store_id. Implement the LRU cache + Secrets Manager lookup described in ADR-006. Until authentication is implemented, any client can write arbitrary data to any DynamoDB partition key.

- [ ] **Create the five missing Terraform modules** (`vpc`, `eks`, `iam`, `secrets`, `s3`). terraform/main.tf references all five; none exist on disk. A `terraform init` fails immediately. No infrastructure can be provisioned.

- [ ] **Uncomment the S3 remote state backend.** terraform/versions.tf lines 19–26: the backend block is commented out. Running `terraform apply` uses local state, recreating the SPOF-7 that ADR-008 was written to prevent. Uncomment this block and bootstrap the S3 bucket and DynamoDB lock table before the first `terraform apply`.

- [ ] **Reduce `maxReplicaCount` to match actual cluster capacity.** keda-scaledobject.yaml line 16: `maxReplicaCount: 50` is unschedulable on `node_max_size: 3` t3.micro nodes (variables.tf line 43). Set `maxReplicaCount: 10` until the cluster is sized appropriately or the Cluster Autoscaler is configured and the node max is increased.

---

### P1 — Must Fix Within First Sprint

- [ ] **Add DLQ CloudWatch alarm to the SQS Terraform module.** terraform/modules/sqs/main.tf: add an `aws_cloudwatch_metric_alarm` for `ApproximateNumberOfMessagesVisible` on the DLQ with threshold 0, period 60 seconds, and an SNS topic with PagerDuty or email subscription. Without this alarm, DLQ accumulation is silent for 14 days.

- [ ] **Add `store_id` to the SQS message body.** app/internal/queue/sqs.go currently marshals only the `Sale` struct. The consumer (app/internal/consumer/dynamodb.go) has no access to `store_id` when writing to DynamoDB. Add `store_id` to the SQS message JSON and extract it in the consumer.

- [ ] **Set ALB deregistration delay to match terminationGracePeriodSeconds.** Add annotation `alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=30` to the Ingress in k8s/manifests.yaml. Without this, the ALB routes new requests to a terminating pod for up to 300 seconds after SIGTERM while the Go server stops accepting connections at second 15.

- [ ] **Implement rate limiting in the handler.** ADR-003 and ADR-010 specify a per-store token bucket at 5,000 requests/hour with HTTP 429 and Retry-After header. No rate limiting exists in app/internal/handler/sales.go. A misconfigured store can saturate the entire SQS queue.

- [ ] **Add Kubernetes NetworkPolicy.** Create NetworkPolicy resources restricting: API pod egress to SQS HTTPS endpoints only; consumer pod egress to SQS and DynamoDB HTTPS endpoints only; no ingress between pods in the sales namespace.

- [ ] **Add ALB access logging.** Add `alb.ingress.kubernetes.io/load-balancer-attributes: access_logs.s3.enabled=true,access_logs.s3.bucket=<bucket>,access_logs.s3.prefix=sales-alb` to the Ingress and create the S3 bucket with appropriate bucket policy for ALB delivery.

- [ ] **Increase `terminationGracePeriodSeconds` to 60 for the consumer.** k8s/consumer-deployment.yaml line 28: 30 seconds is insufficient when the long-poll can block for 20 seconds plus message processing time. Set to 60 to ensure the current batch completes before SIGKILL.

- [ ] **Add AWS Budget alarm.** Add an `aws_budgets_budget` resource with SNS alert at 80% and 100% of the expected monthly budget. Given SQS costs alone can reach $864/month at sustained peak, a budget cap is essential to detect runaway cost from a consumer loop bug.

- [ ] **Pin EKS version.** Add a `kubernetes_version` variable to the EKS module (once created) and set it explicitly. Without version pinning, a maintenance window auto-upgrade can break KEDA compatibility and halt consumer scaling.

- [ ] **Validate KEDA TriggerAuthentication IRSA end-to-end.** keda-scaledobject.yaml references `keda-aws-credentials` TriggerAuthentication. The KEDA operator service account must be annotated with an IRSA role ARN that has `sqs:GetQueueAttributes`. This role is described in ADR-006 but the IAM module does not exist. Verify the role is created and annotated before deploying KEDA.

---

### P2 — Must Fix Within First Quarter

- [ ] **Implement Secrets Manager rotation Lambda.** Create a Lambda function using the AWS-managed SecretsManager rotation template for the store API key secrets. Configure `aws_secretsmanager_secret_rotation` in the secrets module. Define and test the dual-validity window (old and new key both accepted during the rotation window) to prevent 401 errors during rotation.

- [ ] **Load test the system at 3M requests/hour.** No load test exists. Run k6 or locust against a staging environment and validate: API latency at p99, queue depth stability under sustained load, consumer throughput against DynamoDB, DynamoDB hot partition behavior during a burst to a single store. The ADR's theoretical throughput calculations (20 consumer pods * 40–50 writes/second) must be validated empirically before claiming capacity.

- [ ] **Implement per-store rate limiting with a distributed counter.** ADR-003 deferred cross-pod coordination to "a later iteration." An in-memory per-pod rate limiter multiplies the effective limit by the pod count. At 10 API pods, a single store can send 50,000 requests/hour before being throttled. Use DynamoDB atomic counters or ElastiCache for cross-pod coordination.

- [ ] **Implement application-layer PII encryption for the `buyer` field.** ADR-002 deferred per-store KMS key encryption. Until implemented, GDPR right-to-erasure for a specific buyer requires scanning and deleting individual DynamoDB records. Application-layer encryption allows key deletion to render all store records unreadable without table mutation.

- [ ] **Implement multi-environment Terraform workspaces.** Create `terraform/environments/dev/`, `staging/`, and `prod/` directories with environment-specific tfvars. Enforce workspace selection in CI/CD. Run `terraform plan` and automated testing against staging before any prod apply.

- [ ] **Implement chaos engineering tests.** At minimum: kill a consumer pod during high-throughput processing and verify no messages are lost; throttle DynamoDB and verify messages are not permanently lost; kill an API pod during a rolling deployment and verify requests are not dropped. Document results and remediation steps.

- [ ] **Define and publish SLOs with error budgets.** No SLOs exist anywhere in the agent outputs. Define: API availability (e.g., 99.9%), write-to-DynamoDB latency p99 (e.g., <5 minutes), DLQ depth = 0 (any DLQ message triggers P1 incident), consumer queue lag (depth <1000 during business hours). Implement alerting thresholds based on error budget burn rate.

- [ ] **Test DynamoDB PITR restore end-to-end.** PITR is enabled but has never been tested. Schedule a monthly restore drill: restore the table to a point in time into a separate table name, validate record counts and a sample of individual records match expectations. Document the restore procedure and RTO/RPO in the runbook.

- [ ] **Enable ECR image scanning.** Add `image_scanning_configuration { scan_on_push = true }` to both ECR repository resources. Integrate scan results into the CI/CD pipeline; block deployments if HIGH or CRITICAL CVEs are found.

- [ ] **Write an operations runbook.** The runbook must cover: responding to a DLQ alarm (manual reprocess vs. root cause investigation); responding to DynamoDB throttling; rotating a store API key; rolling back a failed deployment; bootstrapping Terraform state from scratch; what to do if the KEDA operator crashes; how to confirm KEDA is actually scaling by inspecting `kubectl get scaledobject`.

---

## Section 5: Verdict

This architecture will not survive Day 1 of production traffic in its current form. Before the first request can be processed, two blocking defects must be resolved: the missing `go.sum` file (app/ directory) prevents building any Docker image — the Dockerfile COPY instruction at line 7 fails with "file not found" — and the missing `store_id` partition key in the DynamoDB PutItem call (app/internal/consumer/dynamodb.go lines 189–196) means every message the consumer processes fails with a `ValidationException`, is retried three times, and moves to the DLQ, resulting in zero records ever reaching DynamoDB. Beyond these build-and-runtime blockers, five of seven Terraform modules referenced in main.tf do not exist on disk, making `terraform init` fail before any infrastructure can be provisioned. The authentication architecture described across four ADRs was never implemented: the handler accepts any string as a valid store_id with no Secrets Manager lookup. The KEDA ScaledObject polls an empty queue URL. The consumer liveness probe uses `/bin/sh` which does not exist in a scratch container, putting the consumer in a permanent crash loop. The most likely Day 1 failure sequence is: `docker build` fails due to missing go.sum, and if that is manually worked around, every sale record fails the DynamoDB write and the DLQ fills entirely within minutes. The single change with the highest impact on reliability is adding the `store_id` attribute to the DynamoDB PutItem call — it is one field in one map in one file, and without it the entire system is an expensive queue that writes nothing to the database.

---

*Generated by Reviewer Agent — EPCC Phase C — 2026-03-13*

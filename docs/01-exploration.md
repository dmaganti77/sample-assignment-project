# Sales Tracker — Exploration Document

**Phase:** E — Explore (Architect Agent)
**Date:** 2026-03-12
**Problem:** Design a sales tracking backend for 200 stores.
**API:** `POST /sales { "quantity": int, "buyer": string, "time": UTC }`
**Scale:** 1 to 3,000,000 requests per hour
**Platform:** Kubernetes (EKS on AWS), IaC: Terraform

---

## System Challenges

### Challenge 1: Extreme Traffic Variability (3,000,000x Range)

The system must handle traffic ranging from 1 request per hour (essentially idle) to 3,000,000 requests per hour (833 RPS). This is a 3,000,000x range — not a simple 2x or 10x peak-to-valley ratio. Standard auto-scaling approaches assume traffic grows and shrinks within a bounded envelope; here the lower bound is effectively zero and the upper bound is very high. The key problem is that scaling infrastructure to handle peak load is expensive when idle time dominates, yet under-provisioning for peak will cause ingestion failures and lost sales data.

At 833 RPS sustained, with each request requiring payload parsing, validation, authentication, and a write to durable storage, the system must maintain both throughput and acceptable latency under continuous high load. Burst conditions — such as a flash sale across all 200 stores simultaneously — could momentarily exceed the 3M/hour sustained figure.

### Challenge 2: Write-Heavy Workload with Durable Guarantee

The `POST /sales` endpoint is a pure write path. The system will be write-heavy with a near-zero read path at ingestion time. However, sales data is financial and business-critical: every write must be durable. Data loss is unacceptable — a dropped sale record has real business consequences (inventory miscount, revenue reconciliation failure, audit trail gaps).

This creates a fundamental tension: high-throughput write systems typically sacrifice durability guarantees (write to buffer, flush later), but financial data requires the opposite. The naive path — write synchronously to a strongly consistent database on every API call — will become the primary bottleneck at scale.

### Challenge 3: Hot Partition Risk from 200-Store Distribution

With 200 stores as the natural partitioning dimension, partition skew is a real risk. If store IDs are naively used as partition keys and traffic is unevenly distributed (e.g., a flagship store in a major city processes 10x the volume of a rural store), certain partitions will become hot spots. Hot partitions cause localized throttling and latency degradation even when aggregate system capacity appears sufficient. The problem is that the skew pattern may be dynamic — holiday events at specific locations, store openings, flash sales — making static pre-sharding insufficient.

### Challenge 4: Idempotency and Duplicate Ingestion

At high RPS, clients (point-of-sale systems in stores) will retry failed or timed-out requests. Without idempotency controls, a network hiccup during the store-to-API transmission results in the same sale being recorded multiple times. Detecting duplicates requires either a unique sale identifier in the payload (which the current API schema does not include — `quantity`, `buyer`, `time` with no transaction ID) or a computed deduplication key derived from the existing fields. The combination of `(buyer, time, quantity, store_id)` may not be globally unique — two buyers with the same name could purchase the same quantity at the same second in the same store.

The absence of an explicit idempotency key in the API contract is a schema gap that creates downstream deduplication complexity.

### Challenge 5: Time Synchronization and Clock Skew

The `time` field is UTC and presumably supplied by the store's point-of-sale system. Store clocks are not guaranteed to be synchronized. A store with a clock drifted by 60 seconds will send sale records with timestamps 60 seconds in the past or future. This has implications for:

- Time-ordered queries and reporting (sales "out of order" in the ingestion stream)
- Deduplication logic (if using time as part of a dedup key, clock drift invalidates assumptions)
- Audit and compliance requirements (which timestamp is authoritative — the store's or the server's receipt time?)

The system must decide whether to trust the client-supplied `time` field or to stamp records with server-side ingestion time, or to store both.

### Challenge 6: Operational Observability Gap at Scale

At 833 sustained RPS, a silent failure mode — where 1% of writes are dropped due to a misconfigured retry policy or a downstream queue overflow — will manifest as 8 lost sales per second. Over an hour that is 28,800 lost records. Without per-request tracing, queue depth monitoring, and write success/failure metrics, these silent drops will not be detected until a business reconciliation reveals discrepancies hours or days later. The observability gap between "API returned 200 OK" and "record is durably stored" is a critical risk at this scale.

### Challenge 7: Security Surface Across 200 Store Endpoints

Each of the 200 stores is an untrusted external client calling the public API. The attack surface includes:

- Unauthorized writes (a rogue or compromised POS terminal submitting fraudulent sales)
- Data injection attacks via the `buyer` field (which is a free-form string)
- Volumetric abuse — a misconfigured or malicious store client sending at 100x its normal rate
- Credential management for 200 stores (how are store identities authenticated and rotated?)

The current API schema has no store identifier in the payload body. Store identity must come from authentication context (e.g., a bearer token or mTLS certificate), which means the authentication layer carries critical business logic — it is not just a security control, it is the source of the `store_id` that drives partitioning and reporting.

---

## CAP Theorem Analysis

### The Core Tradeoff

Under the CAP theorem, a distributed system can guarantee at most two of: Consistency, Availability, and Partition Tolerance. In practice, network partitions in any distributed system (including Kubernetes on AWS across multiple AZs) are not a matter of "if" but "when." This means the real decision is **Consistency vs. Availability** during a partition event.

### This System: AP (Availability + Partition Tolerance)

**The system must prioritize Availability over strong Consistency.**

Reasoning:

1. **200 stores cannot be blocked.** A store's point-of-sale terminal must be able to record a sale at all times. If the backend becomes temporarily unavailable or returns errors, the store operator faces a choice between blocking the customer transaction or proceeding offline. Blocking a customer transaction at checkout is a severe business failure. The system must accept writes even if it cannot immediately guarantee cross-replica consistency.

2. **Sales data is append-only.** There is no read-modify-write pattern at ingestion time. A `POST /sales` does not need to read existing state before writing. This eliminates the primary reason to demand strong consistency at write time — preventing conflicting updates to shared mutable state.

3. **Eventual consistency is acceptable for aggregation.** Sales reports and analytics (total sales per store, daily revenue) can tolerate a few seconds or even minutes of lag. A dashboard showing "last 5 minutes of sales" does not need to be millisecond-accurate.

4. **What we sacrifice:** During a network partition, replicas may temporarily diverge. A write acknowledged by one replica may not be immediately visible on another. If a partition is followed by a crash before replication, that write could be lost. This is the accepted risk in the AP model — the system minimizes this risk with durable queuing and replication, but cannot eliminate it without sacrificing availability.

### Where Strong Consistency IS Required

Even within an AP model, there is one narrow area where consistency cannot be relaxed: **deduplication**. If the system uses a distributed deduplication store, a split-brain scenario where two replicas independently accept the same sale would result in a duplicate record even if the client sent only one request. The deduplication check must either be strongly consistent (sacrificing availability for that narrow operation) or accept that rare duplicates may slip through (compensating with downstream dedup on read/query).

---

## Potential Single Points of Failure

The following components represent SPOFs in a naive, non-hardened implementation. "Naive" means: single instance, no redundancy, no failover.

### SPOF 1: API Entry Point (Single Load Balancer or Single Ingress)

A single load balancer or Kubernetes Ingress controller with one replica is the first point all 200 stores hit. If it fails, all ingestion stops immediately. Even if the backend is fully healthy, no writes reach it.

### SPOF 2: Single API Server Pod

If the application runs as a single pod (no horizontal scaling, no replica count > 1), a pod crash, OOM kill, node eviction, or rolling deployment with zero downtime misconfiguration causes a complete ingestion blackout. At Kubernetes default settings, a pod restart takes 10–30 seconds — that is up to 25,000 lost sale attempts during a peak hour.

### SPOF 3: Single Kubernetes Node

If all pods are scheduled onto a single node and that node becomes unavailable (hardware failure, AWS instance termination, kernel panic), all pods on it fail simultaneously. A single-node cluster provides no real availability guarantee.

### SPOF 4: Single Availability Zone Deployment

Deploying the entire cluster — nodes, load balancer, storage — within a single AWS Availability Zone means an AZ-level outage (power, network, AWS infrastructure event) takes down the entire system. AWS AZ outages are rare but have occurred historically.

### SPOF 5: Synchronous Database Write on the Hot Path

If the API handler writes directly and synchronously to a database on every request, the database becomes a SPOF in both the failure and the performance sense. A database connection pool exhaustion, a slow query, a replication lag event, or a brief database restart will cause the entire write path to back up or fail. At 833 RPS, a 200ms database write latency means the connection pool must sustain 833 * 0.2 = ~167 concurrent open connections minimum — most database connection pools are not configured for this by default.

### SPOF 6: Single Message Queue

If an intermediate queue is used to buffer writes between the API layer and the storage layer, a single-node or single-partition queue with no redundancy becomes a SPOF. Queue node failure means buffered but unwritten records are lost.

### SPOF 7: Terraform State Backend

The Terraform state file is the source of truth for all infrastructure. If the state backend (e.g., a local file or a single S3 bucket without versioning) is corrupted or inaccessible, infrastructure changes cannot be safely applied. This is an operational SPOF — not a runtime data SPOF, but one that can prevent disaster recovery and scaling operations during an incident.

### SPOF 8: DNS Resolution

All 200 stores resolve the API endpoint via DNS. A DNS misconfiguration, a TTL expiry during a record update, or a DNS provider outage will prevent stores from reaching the API even if the backend is fully healthy.

### SPOF 9: Store Authentication / Secret Store

If store credentials (API keys, mTLS certificates) are stored in a single secret management system with no redundancy, failure of that system prevents all stores from authenticating. At scale, a central secrets store that is called on every request (rather than caching credentials) becomes both a SPOF and a performance bottleneck.

### SPOF 10: Monitoring and Alerting Pipeline

If the observability stack (metrics collection, alerting) is itself a single point of failure, silent failures go undetected. An operator cannot know whether silence in the monitoring dashboard means "all is well" or "the monitoring itself has failed."

---

## Consistency Model

### Recommendation: Eventual Consistency with Durable Write Acknowledgment

**Model:** Eventual consistency on the read path; durable, at-least-once guarantee on the write path.

**Justification:**

**Write path (ingestion):** The API must provide a durable acknowledgment — meaning when the API returns `HTTP 202 Accepted` (or `200 OK`), the write must be persisted to at least one durable medium that survives a process crash. This is not strong consistency across all replicas; it is a durability guarantee for a single accepted write. A write acknowledged without any durability guarantee (e.g., written only to in-memory buffer with no disk/queue flush) is unacceptable for financial data.

**Read path (reporting/analytics):** Reads can tolerate seconds to minutes of staleness. A sales report showing data up to 30 seconds ago is functionally equivalent to one showing real-time data for all practical business purposes. Strong consistency on reads would require distributed coordination that significantly reduces read throughput and increases latency without corresponding business value.

**Why not strong consistency end-to-end:** Strong consistency requires that every write be confirmed across a quorum of replicas before acknowledging to the client. At 833 RPS with multi-AZ replication, the synchronous round-trip cost of quorum writes adds tens of milliseconds of latency to every request and creates a coordination bottleneck. Under network partition, it forces the system to reject writes rather than accept them — which is the wrong tradeoff for 200 stores that must continue transacting.

**The at-least-once vs. exactly-once problem:** Eventual consistency combined with at-least-once delivery means duplicates are possible and must be handled downstream. Exactly-once semantics are extremely expensive in distributed systems and typically require distributed transactions or two-phase commit protocols — both of which are incompatible with high-availability requirements at this scale. The system should accept at-least-once delivery and implement idempotency at the storage layer rather than in the transport layer.

---

## Load Profile

### Traffic Envelope

| Metric | Value |
|--------|-------|
| Minimum load | 1 request/hour (~0.0003 RPS) |
| Maximum sustained load | 3,000,000 requests/hour (833 RPS) |
| Traffic variability ratio | 3,000,000:1 |
| Number of source stores | 200 |
| Average per-store at peak | 15,000 requests/hour (4.17 RPS per store) |

### Burst Characteristics

The 3M/hour figure is a sustained maximum, not an instantaneous peak. The actual burst ceiling is likely higher. Consider the following scenarios:

- **Flash sale event:** A promotional event triggers simultaneous purchases across all 200 stores. If each store's POS system queues up 30 seconds of backlogged transactions and then flushes them simultaneously when connectivity is restored, the system could receive a burst of (833 RPS * 30 seconds) = 24,990 requests in a few seconds — effectively 9M+ requests/hour for a brief window.
- **Store opening rush:** All stores open at 9:00 AM local time (but stores may be in different time zones, distributing the load somewhat). A concentration of stores in one timezone creates a predictable daily peak.
- **Scale-up lag:** Auto-scaling in Kubernetes has a reaction time of 1–3 minutes (HPA polling interval + pod startup time). During this window, the existing pods must absorb the traffic spike. At 833 RPS with a 2-minute scale-up lag, the existing pods must handle approximately 100,000 requests before new capacity arrives.

### Traffic Pattern Classification

This is not a uniform Poisson arrival process. Expected patterns:

- **Daily cycle:** Low traffic overnight (store hours roughly 8AM–10PM local time), peak during lunch hours and early evening.
- **Weekly cycle:** Weekends likely show higher traffic than weekdays for retail stores.
- **Seasonal spikes:** Holiday periods (November/December, major sale events) drive traffic toward the 3M/hour ceiling.
- **Long tail of idle time:** The 1 request/hour minimum suggests the system spends significant time in near-idle state. Cost optimization requires scaling to near-zero during idle periods, but the scale-up path must be fast enough to not drop the first wave of requests when traffic resumes.

### Per-Request Cost Estimate

At 833 RPS, assuming each request requires:
- Network ingress: ~200 bytes payload
- CPU for parsing, validation, auth: ~1–5ms
- Write to durable storage: ~5–50ms (highly variable by storage backend)
- Total estimated latency budget: 50–200ms per request

A single application pod handling 833 RPS at 100ms average latency must sustain 83 concurrent in-flight requests. This is the concurrency number that drives thread pool and connection pool sizing.

---

## Data Access Patterns

### Write Pattern

- **Pattern type:** Append-only inserts; no updates, no deletes at ingestion time.
- **Write volume:** Up to 833 writes/second at peak.
- **Write payload size:** Small (~200–500 bytes per record: quantity, buyer name, timestamp, store_id derived from auth context, server-side receipt timestamp).
- **Write distribution:** Across 200 stores. If stores are evenly active, each store contributes ~4 writes/second at peak. In practice, large stores will dominate.
- **Write acknowledgment requirement:** Durable before `2xx` response.

### Read Pattern

- **Expected read types:** Aggregate queries (total sales per store per day, revenue by time window, top buyers), not individual record lookups.
- **Read frequency:** Low compared to writes. Reads are primarily for reporting and analytics, likely triggered by batch jobs or dashboard refreshes — not on the hot ingestion path.
- **Read/write ratio:** Estimated 1:50 to 1:100 (very write-heavy).
- **Read latency tolerance:** High — reporting queries can take seconds to complete.

### Hot Partition Risk

- **Partition key candidates:** `store_id` is the natural partition key for most access patterns (queries are almost always scoped to a store).
- **Hot partition scenario:** If 10 out of 200 stores generate 80% of the traffic (a realistic Pareto distribution for a retail chain), those 10 stores' partitions receive 8x the average write load. A storage system that distributes data by `store_id` will have 10 hot shards and 190 cold shards.
- **Time-based partitioning alternative:** Partitioning by time (e.g., day or hour) distributes writes more evenly across all stores within a window, but makes per-store queries expensive (requiring a scan across all time partitions to aggregate a store's data).
- **Compound key consideration:** A compound key of `(store_id, time_bucket)` distributes writes across time but maintains store locality. However, this does not solve the hot-store problem — the most active stores still write to their partition most frequently.

### Data Volume Estimation

| Scenario | Requests/day | Records/day | Storage (at 500 bytes/record) |
|----------|-------------|-------------|-------------------------------|
| Minimum | ~24 | ~24 | ~12 KB |
| Average (assume 10% of peak) | ~3,000,000 | ~3,000,000 | ~1.5 GB |
| Maximum sustained | ~72,000,000 | ~72,000,000 | ~36 GB/day |

At maximum sustained load, annual raw data volume approaches 13 TB/year. This is non-trivial for storage cost and query performance planning, particularly for aggregate analytics over large time windows.

### Data Retention and Lifecycle

The problem statement does not specify retention requirements. However, financial and sales data typically has regulatory retention requirements (7 years in many jurisdictions). 13 TB/year * 7 years = ~91 TB of raw data. Query performance over 91 TB without tiering, archiving, or pre-aggregation will be severely degraded. This is a data lifecycle challenge that must be addressed before the system reaches maturity.

---

## Additional System Design Challenges

### Network and Connectivity

- **Store-to-API reliability:** POS terminals in stores may have unreliable internet connectivity. The system must be designed for clients that retry aggressively. There is no guarantee that a store's connection is stable or low-latency.
- **Regional latency:** If stores are geographically distributed (e.g., across the US or internationally), API response time from a single-region deployment will vary. A store on the US West Coast calling an API deployed in `us-east-1` will experience 60–80ms of additional latency per request, increasing the server-side concurrency requirement.
- **TLS termination overhead:** At 833 RPS, TLS handshake overhead for new connections is significant if connection reuse (keep-alive) is not enforced. POS systems may not implement HTTP keep-alive correctly.

### Schema and Data Model Constraints

- **No transaction ID in API schema:** The current schema `{ "quantity": int, "buyer": string, "time": UTC }` has no idempotency key. This is a fundamental schema design problem.
- **Buyer field is free-form string:** No validation specified. This creates data quality issues (duplicate buyers recorded under slightly different names) and security risks (injection, excessively long strings causing storage anomalies).
- **No store identifier in payload:** Store identity must come from the authentication layer. This tightly couples the authentication mechanism to the data model — changing auth mechanisms (e.g., rotating from API keys to mTLS) requires careful handling to preserve the `store_id` mapping.
- **Quantity field is unbounded integer:** No minimum or maximum specified. A misconfigured POS terminal could submit `quantity: -1000000` or `quantity: 0`. The system needs validation constraints that are not defined in the current spec.

### Operational and Deployment Challenges

- **Zero-downtime deployments:** At 833 RPS, a rolling deployment that takes a pod out of service for 30 seconds must redistribute ~25,000 requests to remaining pods. Without proper readiness probes, pre-stop hooks, and graceful shutdown periods, requests in-flight during pod termination will be dropped.
- **Terraform state management at scale:** Managing EKS, VPC, IAM, and storage infrastructure via Terraform across multiple environments (dev, staging, prod) with multiple engineers requires remote state locking and a disciplined workspace strategy. State corruption or concurrent applies are a real operational risk.
- **Secret rotation for 200 stores:** Rotating API credentials for 200 stores without service interruption requires a rotation strategy — old and new credentials must be valid simultaneously during the rotation window. This is an operational process challenge, not just a technical one.
- **Kubernetes version upgrades:** EKS node group upgrades require draining nodes, which involves graceful pod termination. At high traffic, draining a node without dropping requests requires careful PodDisruptionBudget configuration and sufficient spare capacity.

### Cost and Free-Tier Constraints

- **EKS control plane cost:** EKS charges $0.10/hour per cluster (~$73/month) even with zero worker nodes. This is a fixed cost floor.
- **Scaling cost vs. performance:** Auto-scaling aggressively to handle peaks costs money. Scaling conservatively drops requests. The cost-performance tradeoff must be explicitly modeled against the traffic distribution (how often is the system near peak vs. near idle?).
- **Data transfer costs:** 200 stores sending HTTP requests means inbound data transfer. AWS charges for outbound but not inbound data transfer to EC2/EKS — however, cross-AZ traffic within AWS (e.g., between application pods in one AZ and a database in another) is charged at $0.01/GB each way. At high write volumes, cross-AZ traffic costs can accumulate.
- **Storage costs at scale:** At 36 GB/day of raw record storage at peak, monthly storage costs must be modeled against chosen storage backend pricing.

### Security Challenges

- **API authentication for 200 stores:** Each store must have a unique identity credential. Managing 200 credential sets — issuance, storage, rotation, revocation — is a significant operational burden.
- **Rate limiting per store:** Without per-store rate limiting, a single misconfigured or compromised store can saturate the entire ingestion pipeline, causing a denial-of-service for all other stores.
- **Data privacy:** The `buyer` field contains personally identifiable information (a person's name). Depending on jurisdiction, this may require GDPR or CCPA compliance, encryption at rest and in transit, data residency constraints, and deletion capabilities (right to be forgotten). The current schema stores PII indefinitely with no deletion mechanism specified.
- **Audit logging:** For financial data, a complete audit log of who wrote what and when (including server-side receipt timestamps, source IP, and authentication identity) is typically required. This doubles the write workload if audit logs are stored separately.

---

## Handoff to Infrastructure Agent

The Infrastructure Agent must design an architecture that satisfies the following hard constraints identified in this exploration:

1. **Availability over consistency.** The system is AP. Infrastructure choices must prioritize uptime for all 200 stores over synchronous cross-replica consistency. No single component should be a blocking dependency for accepting writes.

2. **Durability before acknowledgment.** Even in an AP system, every acknowledged write must be durably persisted. The infrastructure must provide at least one durable write step before the API responds `2xx`. In-memory buffers with no persistence guarantee are not acceptable as the sole write path.

3. **Eliminate all listed SPOFs.** Each of the 10 SPOFs identified above must be addressed: multi-replica API pods, multi-node cluster, multi-AZ deployment, non-synchronous database write on the hot path, redundant queue, versioned Terraform state, DNS redundancy, cached/distributed credential validation, and redundant observability.

4. **Handle 3,000,000x traffic variability.** The infrastructure must support scaling from near-zero to 833+ RPS. Static provisioning at peak capacity is cost-prohibitive given the idle time distribution. Auto-scaling must be fast enough to absorb burst traffic without dropping requests during the scale-up lag window.

5. **Mitigate hot partitions.** The storage design must handle the case where 10 out of 200 stores generate 80% of the write traffic. Partition strategy must not create unbounded hot spots.

6. **Idempotency at the infrastructure level.** Because the API schema lacks an explicit idempotency key, the infrastructure must provide a mechanism (deduplication hash, unique constraint, or idempotency layer) to prevent duplicate records from store retries.

7. **Per-store rate limiting.** The infrastructure must enforce per-store write rate limits to prevent any single store from denying service to the ingestion pipeline for all other stores.

8. **PII handling.** The `buyer` field contains PII. Infrastructure must enforce encryption at rest and in transit. The storage design should allow for targeted record deletion (for compliance with right-to-erasure requests).

9. **Terraform state must be remote and locked.** Local Terraform state is an operational SPOF. The infrastructure design must include a remote state backend with state locking from the start.

10. **Observability gap.** The infrastructure must close the observability gap between "API accepted the write" and "write is durably stored." Metrics, tracing, and alerting must span the entire write path, not just the API layer.

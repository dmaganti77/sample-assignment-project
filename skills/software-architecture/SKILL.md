---
name: software-architecture
description: System design principles from awesome-system-design-resources. Loaded into architect and reviewer agents.
---

# Software Architecture Skill

Reference from: https://github.com/ashishps1/awesome-system-design-resources

## Core Principles to Apply

### Scalability
- Horizontal scaling preferred over vertical
- Stateless services enable easy horizontal scaling
- Identify bottlenecks before they occur
- Design for 10x current load

### Availability
- Define SLAs upfront (99.9% = 8.7hrs downtime/year, 99.99% = 52min/year)
- Multi-AZ deployments for HA
- Avoid cascading failures with bulkheads
- Use health checks and circuit breakers

### CAP Theorem
- Consistency: All nodes see same data simultaneously
- Availability: System always responds (may not be latest data)
- Partition Tolerance: System works despite network failures
- **You can only guarantee 2 of 3**
- For sales tracking: Choose AP (Availability + Partition Tolerance)
  - Eventual consistency acceptable — a sale recorded 100ms later is fine
  - System unavailability is NOT acceptable — store can't stop selling

### Rate Limiting
- Protect downstream services from thundering herd
- Token bucket for smooth bursts
- Apply at API Gateway layer, not application layer
- Return 429 with Retry-After header

### Message Queues
- Decouple producers from consumers
- Buffer traffic spikes (1M req/hr spike → queue absorbs, consumer processes steadily)
- Enable async processing → lower API latency
- Dead Letter Queue for failed messages

### Load Balancing
- Layer 7 (ALB) for HTTP workloads — path-based routing, SSL termination
- Distribute across AZs, not just instances
- Connection draining on scale-in

### SPOF Elimination
- Single instance = SPOF → always run minimum 2 replicas
- Single AZ = SPOF → multi-AZ everything
- Single database = SPOF → read replicas or multi-region
- Single region = SPOF (for critical systems) → active-active or active-passive

### Fault Tolerance
- Retry with exponential backoff + jitter
- Circuit breaker: open after N failures, half-open to test recovery
- Timeout everything — never wait forever
- Graceful degradation: serve stale data > serve errors

### Idempotency
- POST /sales called twice with same data = only 1 sale recorded
- Use deterministic ID from payload (hash of buyer + time)
- SQS MessageDeduplicationId for exactly-once delivery
- DynamoDB conditional writes to prevent duplicates

### Database Patterns for This Problem
- **NoSQL (DynamoDB)**: Better for high-write, simple key-value, auto-scaling
- **Sharding by store_id**: Distribute load across partitions
- **Time-based sort key**: Efficient range queries by time
- **Avoid hot partitions**: Don't use sequential IDs as partition keys

### Consistent Hashing
- Distribute load evenly across nodes
- Minimal redistribution when nodes added/removed
- Relevant for sharding DynamoDB partition keys

### Observability (The Three Pillars)
- **Metrics**: SQS queue depth, consumer lag, API latency p50/p95/p99, error rate
- **Logs**: Structured JSON, correlation IDs, trace IDs
- **Traces**: Distributed tracing across API → SQS → Consumer → DynamoDB

### SLO / SLA Targets for This System
- API availability: 99.9%
- API latency p99: < 200ms
- Sale processing lag (queue to DB): < 30 seconds
- Data loss: 0 (SQS standard = at-least-once, handle duplicates)

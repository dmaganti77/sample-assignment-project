---
name: subagent-driven-development
description: Orchestration patterns for multi-agent EPCC workflows. Guides the backend agent on task decomposition and handoffs.
---

# Subagent-Driven Development Skill

## EPCC Agent Orchestration Pattern

This project uses the EPCC methodology with specialized agents:

```
Orchestrator (Claude Code)
    │
    ├─→ /architect  [E — Explore]
    │       Identifies challenges, no solutions
    │       Output: Challenge list, CAP analysis, SPOF list
    │
    ├─→ /infrastructure  [P — Plan]
    │       Takes architect output, designs AWS + IaC
    │       Output: ADR, Terraform modules, data flow diagram
    │
    ├─→ /backend  [C — Code]
    │       Takes infrastructure spec, implements Go + K8s
    │       Output: Working code, manifests, Dockerfile
    │
    └─→ /reviewer  [C — Compare]
            Takes all outputs, critiques against production reality
            Output: Compare & contrast table, gaps, Day 2 checklist
```

## Agent Handoff Protocol

Each agent MUST end its output with a structured handoff:

```markdown
### Handoff to [Next Agent]
- Constraint 1: [specific requirement next agent must respect]
- Constraint 2: ...
- Open question: [anything next agent needs to decide]
```

## Code Quality Gates (Backend Agent)

Before marking code complete, verify:

- [ ] All functions have error handling (no bare `err` ignores)
- [ ] No hardcoded values (all from environment variables)
- [ ] Graceful shutdown implemented (SIGTERM → drain → exit)
- [ ] Health endpoints return meaningful status
- [ ] All structs have json tags
- [ ] Input validation on all handler inputs
- [ ] Logs include correlation ID for tracing
- [ ] go.mod and go.sum both present

## Kubernetes Manifest Checklist

- [ ] Resource requests AND limits set
- [ ] Liveness and readiness probes configured
- [ ] PodDisruptionBudget created
- [ ] Service account with IRSA annotation
- [ ] No privileged containers
- [ ] Read-only root filesystem where possible
- [ ] KEDA ScaledObject with min/max bounds

## Parallel vs Sequential Execution

For this project, agents run SEQUENTIALLY:
1. Architect must complete before Infrastructure starts
2. Infrastructure must complete before Backend starts  
3. Backend must complete before Reviewer starts

Reason: Each phase's output is input to the next.
Do NOT parallelize — dependencies are strict.

## Output Artifacts Per Agent

| Agent | Output Files |
|-------|-------------|
| architect | docs/01-exploration.md |
| infrastructure | docs/02-architecture-decisions.md, terraform/ |
| backend | app/, k8s/ |
| reviewer | docs/03-compare-contrast.md |

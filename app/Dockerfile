# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Cache dependencies separately from source code
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build static binary — no CGO, no external dependencies
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-w -s" -o /sales-tracker ./cmd/main.go

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM scratch

# Copy CA certificates for HTTPS (SQS/DynamoDB calls)
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy compiled binary
COPY --from=builder /sales-tracker /sales-tracker

# Run as non-root (numeric UID for scratch image compatibility)
USER 65534:65534

EXPOSE 8080

ENTRYPOINT ["/sales-tracker"]

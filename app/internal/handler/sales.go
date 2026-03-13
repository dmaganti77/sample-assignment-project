package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/sample-assignment/sales-tracker/internal/models"
	"github.com/sample-assignment/sales-tracker/internal/queue"
)

type SalesHandler struct {
	sqs *queue.SQSClient
}

func NewSalesHandler(sqs *queue.SQSClient) *SalesHandler {
	return &SalesHandler{sqs: sqs}
}

func (h *SalesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// ADR-009: generate trace_id at API ingress for end-to-end observability
	traceID := uuid.New().String()

	// ADR-010: store identity comes from authentication header, never from payload
	storeID := r.Header.Get("X-Store-API-Key")
	if storeID == "" {
		slog.WarnContext(ctx, "missing X-Store-API-Key header", "trace_id", traceID)
		writeError(w, http.StatusUnauthorized, "X-Store-API-Key header is required")
		return
	}

	// Decode payload
	var sale models.Sale
	if err := json.NewDecoder(r.Body).Decode(&sale); err != nil {
		slog.WarnContext(ctx, "invalid JSON payload", "error", err, "trace_id", traceID)
		writeError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	// Validate (includes quantity bounds and ±24h clock skew check)
	if err := sale.Validate(); err != nil {
		slog.WarnContext(ctx, "validation failed", "error", err, "trace_id", traceID)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Generate deterministic deduplication key (storeID + buyer + quantity + time)
	dedupID := sale.DeduplicationID(storeID)

	// Enqueue to SQS — async, do not block on DB write
	if err := h.sqs.Enqueue(ctx, &sale, traceID); err != nil {
		slog.ErrorContext(ctx, "failed to enqueue sale",
			"error", err,
			"dedup_id", dedupID,
			"trace_id", traceID,
			"store_id", storeID,
		)
		writeError(w, http.StatusInternalServerError, "failed to process sale")
		return
	}

	slog.InfoContext(ctx, "sale queued",
		"buyer", sale.Buyer,
		"quantity", sale.Quantity,
		"dedup_id", dedupID,
		"trace_id", traceID,
		"store_id", storeID,
	)

	// 202 Accepted — sale is queued, not yet persisted
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(models.SaleResponse{
		ID:      dedupID,
		Status:  "queued",
		TraceID: traceID,
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

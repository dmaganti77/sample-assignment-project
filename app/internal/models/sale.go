package models

import (
	"crypto/sha256"
	"fmt"
	"strconv"
	"time"
)

// Sale represents the incoming POST /sales payload
type Sale struct {
	Quantity int    `json:"quantity"`
	Buyer    string `json:"buyer"`
	Time     string `json:"time"`
}

// SaleRecord is what gets persisted to DynamoDB
type SaleRecord struct {
	StoreID   string    `json:"store_id"`
	SaleID    string    `json:"sale_id"`
	Quantity  int       `json:"quantity"`
	Buyer     string    `json:"buyer"`
	SaleTime  time.Time `json:"sale_time"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt int64     `json:"expires_at"` // Unix timestamp for DynamoDB TTL
}

// SaleResponse is returned to the caller
type SaleResponse struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	TraceID string `json:"trace_id"`
}

// Validate checks required fields and constraints.
// Returns an error if any field is invalid or the timestamp is outside
// the ±24-hour clock skew window (ADR-010).
func (s *Sale) Validate() error {
	if s.Quantity <= 0 {
		return fmt.Errorf("quantity must be greater than 0, got %d", s.Quantity)
	}
	if s.Quantity > 10000 {
		return fmt.Errorf("quantity exceeds maximum allowed per transaction (10000), got %d", s.Quantity)
	}
	if s.Buyer == "" {
		return fmt.Errorf("buyer is required")
	}
	if len(s.Buyer) > 255 {
		return fmt.Errorf("buyer name exceeds maximum length of 255 characters")
	}
	if s.Time == "" {
		return fmt.Errorf("time is required")
	}
	t, err := time.Parse(time.RFC3339, s.Time)
	if err != nil {
		return fmt.Errorf("time must be valid RFC3339/UTC format, got: %s", s.Time)
	}

	// ADR-010: reject timestamps more than 24 hours in the past or future
	now := time.Now().UTC()
	delta := t.UTC().Sub(now)
	if delta > 24*time.Hour || delta < -24*time.Hour {
		return fmt.Errorf("time is outside the ±24-hour clock skew window: %s", s.Time)
	}

	return nil
}

// DeduplicationID generates a deterministic hash from storeID + buyer + quantity + time.
// Used as a conditional-write key in DynamoDB to prevent duplicate persists
// for a Standard SQS queue (idempotency handled at consumer layer per ADR-001).
func (s *Sale) DeduplicationID(storeID string) string {
	h := sha256.New()
	h.Write([]byte(storeID + "|" + s.Buyer + "|" + strconv.Itoa(s.Quantity) + "|" + s.Time))
	return fmt.Sprintf("%x", h.Sum(nil))
}

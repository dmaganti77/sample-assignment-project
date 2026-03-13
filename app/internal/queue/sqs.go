package queue

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/sample-assignment/sales-tracker/internal/models"
)

type SQSClient struct {
	client   *sqs.Client
	queueURL string
}

func NewSQSClient(region, queueURL string) (*SQSClient, error) {
	if region == "" {
		return nil, fmt.Errorf("AWS_REGION is required")
	}
	if queueURL == "" {
		return nil, fmt.Errorf("SQS_QUEUE_URL is required")
	}

	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(region),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	return &SQSClient{
		client:   sqs.NewFromConfig(cfg),
		queueURL: queueURL,
	}, nil
}

// Enqueue sends a sale to a Standard SQS queue.
// traceID is attached as a message attribute for end-to-end tracing (ADR-009).
// Idempotency for Standard queues is handled at the DynamoDB consumer layer
// via conditional writes — FIFO-only fields (MessageDeduplicationId,
// MessageGroupId) are intentionally omitted (ADR-001).
func (c *SQSClient) Enqueue(ctx context.Context, sale *models.Sale, traceID string) error {
	body, err := json.Marshal(sale)
	if err != nil {
		return fmt.Errorf("failed to marshal sale: %w", err)
	}

	input := &sqs.SendMessageInput{
		QueueUrl:    &c.queueURL,
		MessageBody: strPtr(string(body)),
		MessageAttributes: map[string]types.MessageAttributeValue{
			"ContentType": {
				DataType:    strPtr("String"),
				StringValue: strPtr("application/json"),
			},
			"TraceID": {
				DataType:    strPtr("String"),
				StringValue: strPtr(traceID),
			},
		},
	}

	_, err = c.client.SendMessage(ctx, input)
	if err != nil {
		return fmt.Errorf("failed to send message to SQS: %w", err)
	}
	return nil
}

// Ping checks SQS connectivity — used by readiness probe
func (c *SQSClient) Ping(ctx context.Context) error {
	_, err := c.client.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl: &c.queueURL,
	})
	return err
}

func strPtr(s string) *string {
	return &s
}

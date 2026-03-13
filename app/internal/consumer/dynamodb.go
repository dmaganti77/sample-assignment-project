package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	sqssvc "github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/sample-assignment/sales-tracker/internal/models"
)

const (
	// maxMessages is the SQS ReceiveMessage batch size (maximum allowed by AWS)
	maxMessages = 10
	// visibilityTimeout gives the consumer 30 seconds to process before the
	// message becomes visible again for retry
	visibilityTimeout = 30
	// waitTimeSeconds enables SQS long polling to reduce empty-receive costs
	waitTimeSeconds = 20
)

// Consumer polls an SQS queue and writes each sale to DynamoDB.
// Idempotency is enforced via a DynamoDB conditional write
// (attribute_not_exists(sale_id)), making it safe to receive the same SQS
// message more than once (Standard queue at-least-once delivery).
type Consumer struct {
	sqsClient    *sqssvc.Client
	dynamoClient *dynamodb.Client
	queueURL     string
	tableName    string
}

// NewConsumer creates a Consumer with the provided AWS clients.
// Callers are responsible for constructing the clients from a loaded config.
func NewConsumer(
	sqsClient *sqssvc.Client,
	dynamoClient *dynamodb.Client,
	queueURL string,
	tableName string,
) (*Consumer, error) {
	if queueURL == "" {
		return nil, fmt.Errorf("SQS_QUEUE_URL is required")
	}
	if tableName == "" {
		return nil, fmt.Errorf("DYNAMODB_TABLE_NAME is required")
	}
	return &Consumer{
		sqsClient:    sqsClient,
		dynamoClient: dynamoClient,
		queueURL:     queueURL,
		tableName:    tableName,
	}, nil
}

// Run polls SQS in a loop until ctx is cancelled (SIGTERM).
// Each batch of messages is processed sequentially; a failed individual
// message is left in-flight so that SQS retries it after the visibility
// timeout expires.
func (c *Consumer) Run(ctx context.Context) {
	slog.Info("consumer starting", "queue_url", c.queueURL, "table", c.tableName)
	for {
		select {
		case <-ctx.Done():
			slog.Info("consumer stopping — context cancelled")
			return
		default:
			c.receiveBatch(ctx)
		}
	}
}

// receiveBatch fetches up to maxMessages from SQS and processes each one.
func (c *Consumer) receiveBatch(ctx context.Context) {
	out, err := c.sqsClient.ReceiveMessage(ctx, &sqssvc.ReceiveMessageInput{
		QueueUrl:              aws.String(c.queueURL),
		MaxNumberOfMessages:   maxMessages,
		WaitTimeSeconds:       waitTimeSeconds,
		VisibilityTimeout:     visibilityTimeout,
		MessageAttributeNames: []string{"TraceID"},
	})
	if err != nil {
		// Context cancelled during long-poll — expected on shutdown
		if errors.Is(err, context.Canceled) {
			return
		}
		slog.Error("failed to receive SQS messages", "error", err)
		// Brief pause before retry to avoid tight-looping on persistent errors
		time.Sleep(2 * time.Second)
		return
	}

	for _, msg := range out.Messages {
		c.processMessage(ctx, msg)
	}
}

// processMessage unmarshals one SQS message, writes it to DynamoDB, and
// deletes the message on success. On a DynamoDB conditional check failure
// (duplicate) it also deletes — the record already exists. On any other
// error it does NOT delete, letting the message become visible again for retry.
func (c *Consumer) processMessage(ctx context.Context, msg sqstypes.Message) {
	traceID := extractTraceID(msg)

	if msg.Body == nil {
		slog.Error("received SQS message with nil body — skipping",
			"message_id", aws.ToString(msg.MessageId),
			"trace_id", traceID,
		)
		// Delete malformed messages so they do not loop forever
		c.deleteMessage(ctx, msg, traceID)
		return
	}

	var sale models.Sale
	if err := json.Unmarshal([]byte(*msg.Body), &sale); err != nil {
		slog.Error("failed to unmarshal sale from SQS message",
			"error", err,
			"message_id", aws.ToString(msg.MessageId),
			"trace_id", traceID,
		)
		// Unparseable messages cannot be retried successfully; delete them
		c.deleteMessage(ctx, msg, traceID)
		return
	}

	slog.Info("processing sale",
		"buyer", sale.Buyer,
		"quantity", sale.Quantity,
		"message_id", aws.ToString(msg.MessageId),
		"trace_id", traceID,
	)

	if err := c.writeToDynamoDB(ctx, &sale, traceID); err != nil {
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			// Duplicate — the record already exists in DynamoDB.
			// Delete the SQS message to prevent reprocessing.
			slog.Info("duplicate sale detected — idempotent delete",
				"buyer", sale.Buyer,
				"quantity", sale.Quantity,
				"message_id", aws.ToString(msg.MessageId),
				"trace_id", traceID,
			)
			c.deleteMessage(ctx, msg, traceID)
			return
		}

		// Transient or unknown DynamoDB error — leave message in-flight for retry
		slog.Error("failed to write sale to DynamoDB — message will retry",
			"error", err,
			"buyer", sale.Buyer,
			"quantity", sale.Quantity,
			"message_id", aws.ToString(msg.MessageId),
			"trace_id", traceID,
		)
		return
	}

	slog.Info("sale persisted to DynamoDB",
		"buyer", sale.Buyer,
		"quantity", sale.Quantity,
		"message_id", aws.ToString(msg.MessageId),
		"trace_id", traceID,
	)
	c.deleteMessage(ctx, msg, traceID)
}

// writeToDynamoDB persists a sale record with a conditional expression that
// rejects writes if sale_id already exists — the idempotency guarantee for
// Standard SQS at-least-once delivery (ADR-001, ADR-007).
func (c *Consumer) writeToDynamoDB(ctx context.Context, sale *models.Sale, traceID string) error {
	now := time.Now().UTC()

	saleTime, err := time.Parse(time.RFC3339, sale.Time)
	if err != nil {
		return fmt.Errorf("invalid sale time format: %w", err)
	}

	// TTL: retain records for 90 days
	expiresAt := now.Add(90 * 24 * time.Hour).Unix()

	item := map[string]types.AttributeValue{
		"sale_id":    &types.AttributeValueMemberS{Value: traceID},
		"buyer":      &types.AttributeValueMemberS{Value: sale.Buyer},
		"quantity":   &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", sale.Quantity)},
		"sale_time":  &types.AttributeValueMemberS{Value: saleTime.UTC().Format(time.RFC3339)},
		"created_at": &types.AttributeValueMemberS{Value: now.Format(time.RFC3339)},
		"expires_at": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", expiresAt)},
	}

	_, err = c.dynamoClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(c.tableName),
		Item:                item,
		ConditionExpression: aws.String("attribute_not_exists(sale_id)"),
	})
	return err
}

// deleteMessage removes a successfully processed (or duplicate) message
// from the queue so that it is not redelivered.
func (c *Consumer) deleteMessage(ctx context.Context, msg sqstypes.Message, traceID string) {
	_, err := c.sqsClient.DeleteMessage(ctx, &sqssvc.DeleteMessageInput{
		QueueUrl:      aws.String(c.queueURL),
		ReceiptHandle: msg.ReceiptHandle,
	})
	if err != nil {
		slog.Error("failed to delete SQS message",
			"error", err,
			"message_id", aws.ToString(msg.MessageId),
			"trace_id", traceID,
		)
	}
}

// extractTraceID reads the TraceID message attribute set by the API handler.
func extractTraceID(msg sqstypes.Message) string {
	if attr, ok := msg.MessageAttributes["TraceID"]; ok && attr.StringValue != nil {
		return *attr.StringValue
	}
	return "unknown"
}

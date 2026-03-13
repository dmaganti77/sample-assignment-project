package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/sample-assignment/sales-tracker/internal/consumer"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	region := os.Getenv("AWS_REGION")
	if region == "" {
		slog.Error("AWS_REGION environment variable is required")
		os.Exit(1)
	}

	queueURL := os.Getenv("SQS_QUEUE_URL")
	if queueURL == "" {
		slog.Error("SQS_QUEUE_URL environment variable is required")
		os.Exit(1)
	}

	tableName := os.Getenv("DYNAMODB_TABLE_NAME")
	if tableName == "" {
		slog.Error("DYNAMODB_TABLE_NAME environment variable is required")
		os.Exit(1)
	}

	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(region),
	)
	if err != nil {
		slog.Error("failed to load AWS config", "error", err)
		os.Exit(1)
	}

	sqsClient := sqs.NewFromConfig(cfg)
	dynamoClient := dynamodb.NewFromConfig(cfg)

	c, err := consumer.NewConsumer(sqsClient, dynamoClient, queueURL, tableName)
	if err != nil {
		slog.Error("failed to create consumer", "error", err)
		os.Exit(1)
	}

	// Graceful shutdown on SIGTERM or SIGINT
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	slog.Info("consumer process starting",
		"region", region,
		"queue_url", queueURL,
		"table_name", tableName,
	)

	c.Run(ctx)

	slog.Info("consumer process stopped")
}

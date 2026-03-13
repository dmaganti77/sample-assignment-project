package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sample-assignment/sales-tracker/internal/handler"
	"github.com/sample-assignment/sales-tracker/internal/queue"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	sqsClient, err := queue.NewSQSClient(
		os.Getenv("AWS_REGION"),
		os.Getenv("SQS_QUEUE_URL"),
	)
	if err != nil {
		slog.Error("failed to create SQS client", "error", err)
		os.Exit(1)
	}

	salesHandler := handler.NewSalesHandler(sqsClient)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /sales", salesHandler.Handle)
	mux.HandleFunc("GET /health/live", healthLive)
	mux.HandleFunc("GET /health/ready", healthReady(sqsClient))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("server starting", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-done
	slog.Info("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
	slog.Info("server stopped")
}

func healthLive(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func healthReady(sqsClient *queue.SQSClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := sqsClient.Ping(r.Context()); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"status":"not ready","reason":"sqs unreachable"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ready"}`))
	}
}

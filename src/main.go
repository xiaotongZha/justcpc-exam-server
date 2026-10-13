package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"justcpc-exam-server/src/exam"
	"justcpc-exam-server/src/store"
	"justcpc-exam-server/src/web"
)

func main() {
	configPath := os.Getenv("JUSTCPC_EXAM_CONFIG")
	if configPath == "" {
		configPath = "config.json"
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("load configuration %s: %v", configPath, err)
	}
	if len(cfg.SessionSecret) < 32 {
		log.Fatalf("session_secret must be set in %s (or JUSTCPC_EXAM_SESSION_SECRET) and contain at least 32 bytes", configPath)
	}
	storage, err := store.Open(filepath.Join(cfg.Data, "exam.sqlite"), cfg.Data)
	if err != nil {
		log.Fatal(err)
	}
	defer storage.Close()
	if err := storage.EnsureLayout(); err != nil {
		log.Fatal(err)
	}
	service := exam.Service{Store: storage, StatementPassword: cfg.StatementPassword}
	if err := service.EnsureAdmin(context.Background(), cfg.AdminUsername, cfg.AdminPassword); err != nil {
		log.Fatal(err)
	}
	server, err := web.NewServer(service, cfg.Listen, cfg.SessionSecret)
	if err != nil {
		log.Fatal(err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// 用 server.Exam（已注入 Notify）运行自动状态切换，边界切换才能广播给长连接订阅者。
	go server.Exam.RunAutoAdvance(ctx, time.Second)

	if checks, err := service.Checks(ctx); err == nil {
		for _, check := range checks {
			status := "OK"
			if !check.OK {
				status = "!!"
			}
			log.Printf("[check %s] %s: %s", status, check.Name, check.Message)
		}
	}

	httpServer := &http.Server{Addr: cfg.Listen, Handler: server.Handler()}
	go func() {
		log.Printf("JustCPC Exam Server listening on %s", cfg.Listen)
		log.Printf("选手入口 http://<本机局域网 IP>:<端口>/  管理员入口 http://<本机局域网 IP>:<端口>/admin")
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	}()

	<-ctx.Done()
	server.CloseEvents() // 先断开长连接，避免 Shutdown 等待超时
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	log.Printf("JustCPC Exam Server stopped")
}

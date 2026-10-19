//go:build !windows

package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func platformConfigPath() string { return "config.json" }
func platformError(err error)    { log.Print(err); os.Exit(1) }
func platformLaunch(_ string, _ bool, run func(context.Context, func(startupInfo)) error) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, func(startupInfo) {}); err != nil {
		platformError(err)
	}
}

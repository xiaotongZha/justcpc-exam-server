package web

import (
	"sync"
	"time"
)

// limiter 是简单的固定窗口限流器，用于登录与下载接口的频率限制。
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	count int
	reset time.Time
}

func newLimiter() *limiter {
	return &limiter{buckets: map[string]*bucket{}}
}

func (l *limiter) allow(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry, ok := l.buckets[key]
	if !ok || now.After(entry.reset) {
		l.buckets[key] = &bucket{count: 1, reset: now.Add(window)}
		return true
	}
	if entry.count >= limit {
		return false
	}
	entry.count++
	return true
}

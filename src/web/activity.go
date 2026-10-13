package web

import (
	"sync"
	"time"
)

// activityTracker 记录考生最近一次请求时间，用于估算在线人数。
type activityTracker struct {
	mu   sync.Mutex
	seen map[int64]time.Time
}

func newActivityTracker() *activityTracker {
	return &activityTracker{seen: map[int64]time.Time{}}
}

func (a *activityTracker) touch(id int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seen[id] = time.Now()
}

func (a *activityTracker) count(window time.Duration) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	cutoff := time.Now().Add(-window)
	total := 0
	for _, at := range a.seen {
		if at.After(cutoff) {
			total++
		}
	}
	return total
}

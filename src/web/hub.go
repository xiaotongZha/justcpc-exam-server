package web

import "sync"

// Event 是推送给长连接订阅者的一条轻量变更信号。前端收到后按类型重新拉取对应数据。
type Event struct {
	Type string `json:"type"` // exam / submission / contestant / audit
}

// hub 是进程内的发布/订阅中心：一个发布者、多个订阅者（SSE 长连接）。
// 每个订阅者可指定只接收哪些类型；topics 为空表示接收全部。
type hub struct {
	mu   sync.Mutex
	subs map[chan Event]map[string]struct{}
}

func newHub() *hub {
	return &hub{subs: map[chan Event]map[string]struct{}{}}
}

// subscribe 注册一个订阅者。topics 为空表示接收所有事件。
func (h *hub) subscribe(topics ...string) chan Event {
	ch := make(chan Event, 16)
	var filter map[string]struct{}
	if len(topics) > 0 {
		filter = make(map[string]struct{}, len(topics))
		for _, topic := range topics {
			filter[topic] = struct{}{}
		}
	}
	h.mu.Lock()
	h.subs[ch] = filter
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan Event) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

// publish 非阻塞广播：订阅者通道满则丢弃该条，绝不阻塞发布者（数据库写入等）。
func (h *hub) publish(event Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, filter := range h.subs {
		if filter != nil {
			if _, ok := filter[event.Type]; !ok {
				continue
			}
		}
		select {
		case ch <- event:
		default:
		}
	}
}

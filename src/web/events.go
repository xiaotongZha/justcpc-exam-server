package web

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// 长连接心跳间隔：既保活连接，也用于刷新学生在线状态。
const sseHeartbeat = 20 * time.Second

// adminEvents 向管理员推送全部变更事件（考试、提交、考生、审计）。
func (s Server) adminEvents(c *gin.Context) {
	s.streamEvents(c, nil)
}

// studentEvents 只推送考试状态事件，避免提交事件在学生端引发刷新风暴。
func (s Server) studentEvents(c *gin.Context) {
	s.streamEvents(c, []string{"exam"})
}

// streamEvents 以 Server-Sent Events 保持长连接并推送事件。
func (s Server) streamEvents(c *gin.Context, topics []string) {
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "当前连接不支持流式响应"})
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // 若前置 nginx，需关闭缓冲
	c.Writer.WriteHeader(http.StatusOK)
	fmt.Fprint(c.Writer, "retry: 3000\n: connected\n\n")
	flusher.Flush()

	ch := s.events.subscribe(topics...)
	defer s.events.unsubscribe(ch)

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	clientGone := c.Request.Context().Done()

	for {
		select {
		case <-clientGone:
			return
		case <-s.done:
			return
		case event, open := <-ch:
			if !open {
				return
			}
			payload, err := json.Marshal(event)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			s.touchActivity(c)
			if _, err := io.WriteString(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// touchActivity 在心跳时刷新学生在线状态（长连接模式下不再有周期轮询请求）。
func (s Server) touchActivity(c *gin.Context) {
	if s.activity == nil {
		return
	}
	if value, ok := c.Get(principalKey); ok {
		if who, ok := value.(principal); ok && who.Role == "student" {
			s.activity.touch(who.ID)
		}
	}
}

package web

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"justcpc-exam-server/src/exam"
)

//go:embed static
var staticFiles embed.FS

type Server struct {
	Exam     exam.Service
	Listen   string
	limiter  *limiter
	activity *activityTracker
	sessions *sessionManager
	events   *hub
	done     chan struct{}
}

const principalKey = "principal"

// NewServer 组装 Web 服务，构建会话管理器与事件广播中心。
func NewServer(examService exam.Service, listen, sessionSecret string) (Server, error) {
	sessions, err := newSessionManager(sessionSecret, 12*time.Hour)
	if err != nil {
		return Server{}, err
	}
	events := newHub()
	// 考试服务每次数据变更后向所有长连接订阅者广播。
	examService.Notify = func(kind string) { events.publish(Event{Type: kind}) }
	return Server{Exam: examService, Listen: listen, sessions: sessions, events: events, done: make(chan struct{})}, nil
}

// CloseEvents 通知所有长连接退出，供优雅关闭时调用。
func (s Server) CloseEvents() {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
}

func (s Server) Handler() *gin.Engine {
	s.limiter = newLimiter()
	s.activity = newActivityTracker()
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	sub, _ := fs.Sub(staticFiles, "static")
	router.GET("/assets/*filepath", gin.WrapH(http.StripPrefix("/assets/", http.FileServer(http.FS(sub)))))
	router.GET("/", func(c *gin.Context) { serveEmbedded(c, "index.html") })
	router.GET("/admin", func(c *gin.Context) { serveEmbedded(c, "admin.html") })

	router.GET("/api/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "justcpc-exam-server"}) })
	api := router.Group("/api")
	api.POST("/login", s.studentLogin)
	api.POST("/logout", s.studentLogout)

	student := api.Group("")
	student.Use(s.requireStudent)
	student.GET("/me", s.studentMe)
	student.GET("/exam", s.studentExam)
	student.GET("/events", s.studentEvents)
	student.GET("/problems", s.studentProblems)
	student.GET("/statement", s.studentStatement)
	student.GET("/problems/:label/last", s.studentLast)
	student.POST("/problems/:label/submissions", s.studentSubmit)
	student.GET("/submissions", s.studentSubmissions)
	student.POST("/early-submit", s.studentEarlySubmit)

	admin := api.Group("/admin")
	admin.POST("/login", s.adminLogin)
	admin.POST("/logout", s.adminLogout)
	adminProtected := admin.Group("")
	adminProtected.Use(s.requireAdmin)
	adminProtected.GET("/me", s.adminMe)
	adminProtected.GET("/status", s.adminStatus)
	adminProtected.GET("/events", s.adminEvents)
	adminProtected.GET("/checks", s.adminChecks)
	adminProtected.GET("/rules", s.adminGetRules)
	adminProtected.PUT("/rules", s.adminUpdateRules)
	adminProtected.GET("/contestants", s.adminContestants)
	adminProtected.POST("/contestants", s.adminAddContestant)
	adminProtected.PUT("/contestants/:id", s.adminUpdateContestant)
	adminProtected.GET("/submissions", s.adminSubmissions)
	adminProtected.GET("/submissions/:id/source", s.adminSubmissionSource)
	adminProtected.POST("/exam/:action", s.adminExamAction)
	adminProtected.PUT("/exam/schedule", s.adminSchedule)
	adminProtected.PUT("/exam/restart", s.adminRestart)
	adminProtected.POST("/import", s.adminImport)
	adminProtected.POST("/import-preview", s.adminImport)
	adminProtected.POST("/export", s.adminExport)
	adminProtected.GET("/audit", s.adminAudit)
	adminProtected.DELETE("/audit", s.adminClearAudit)
	adminProtected.POST("/password", s.adminChangePassword)
	return router
}

func serveEmbedded(c *gin.Context, name string) {
	data, err := staticFiles.ReadFile("static/" + name)
	if err != nil {
		c.String(http.StatusNotFound, "not found")
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

func (s Server) requireStudent(c *gin.Context) {
	value, ok := s.sessions.parse(c.Request, studentCookie)
	if !ok || value.Role != "student" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	valid, err := s.Exam.StudentSessionValid(c.Request.Context(), value.ID, value.ExamGeneration, value.SessionVersion)
	if err != nil {
		fail(c, err)
		return
	}
	if !valid {
		s.sessions.clear(c.Writer, studentCookie)
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "登录已失效，可能已交卷、账号被禁用或考试已更换，请联系监考员"})
		return
	}
	if s.activity != nil {
		s.activity.touch(value.ID)
	}
	c.Set(principalKey, value)
	c.Next()
}

func (s Server) requireAdmin(c *gin.Context) {
	value, ok := s.sessions.parse(c.Request, adminCookie)
	if !ok || value.Role != "admin" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "需要管理员登录"})
		return
	}
	c.Set(principalKey, value)
	c.Next()
}

func (s Server) user(c *gin.Context) principal {
	value, _ := c.Get(principalKey)
	return value.(principal)
}

func bindJSON(c *gin.Context, value any) bool {
	if err := c.ShouldBindJSON(value); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "请求格式错误：" + err.Error()})
		return false
	}
	return true
}

func number(c *gin.Context, key string) int64 {
	value, err := strconv.ParseInt(c.Param(key), 10, 64)
	if err != nil || value < 1 {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "无效的标识"})
		return 0
	}
	return value
}

func fail(c *gin.Context, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, exam.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, exam.ErrExamNotOpen), errors.Is(err, exam.ErrFinished), errors.Is(err, exam.ErrDisabled), errors.Is(err, exam.ErrInvalidState):
		status = http.StatusConflict
	case errors.Is(err, exam.ErrSourceTooLarge), errors.Is(err, exam.ErrInvalidLanguage):
		status = http.StatusBadRequest
	}
	c.AbortWithStatusJSON(status, gin.H{"error": err.Error()})
}

func clientIP(c *gin.Context) string { return c.ClientIP() }

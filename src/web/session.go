package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	studentCookie = "justcpc_exam_student"
	adminCookie   = "justcpc_exam_admin"
)

type principal struct {
	Role string // "student" 或 "admin"
	ID   int64  // 考生 ID；管理员为 0
}

type sessionManager struct {
	key      []byte
	duration time.Duration
}

func newSessionManager(secret string, duration time.Duration) (*sessionManager, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("session_secret 至少需要 32 字节")
	}
	if duration <= 0 {
		duration = 12 * time.Hour
	}
	return &sessionManager{key: []byte(secret), duration: duration}, nil
}

func (m *sessionManager) set(writer http.ResponseWriter, cookie string, value principal) {
	expires := time.Now().Add(m.duration).Unix()
	payload := fmt.Sprintf("%s|%d|%d", value.Role, value.ID, expires)
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	http.SetCookie(writer, &http.Cookie{
		Name: cookie, Value: encoded + "." + m.sign(encoded), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(m.duration.Seconds()),
	})
}

func (m *sessionManager) clear(writer http.ResponseWriter, cookie string) {
	http.SetCookie(writer, &http.Cookie{Name: cookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
}

func (m *sessionManager) parse(request *http.Request, cookie string) (principal, bool) {
	value, err := request.Cookie(cookie)
	if err != nil {
		return principal{}, false
	}
	parts := strings.Split(value.Value, ".")
	if len(parts) != 2 || !hmac.Equal([]byte(parts[1]), []byte(m.sign(parts[0]))) {
		return principal{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return principal{}, false
	}
	values := strings.Split(string(decoded), "|")
	if len(values) != 3 {
		return principal{}, false
	}
	expires, err := strconv.ParseInt(values[2], 10, 64)
	if err != nil || time.Now().Unix() > expires {
		return principal{}, false
	}
	id, err := strconv.ParseInt(values[1], 10, 64)
	if err != nil {
		return principal{}, false
	}
	if values[0] != "student" && values[0] != "admin" {
		return principal{}, false
	}
	return principal{Role: values[0], ID: id}, true
}

func (m *sessionManager) sign(value string) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

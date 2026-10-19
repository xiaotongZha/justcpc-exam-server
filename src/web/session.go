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
	Role           string // "student" 或 "admin"
	ID             int64  // 考生 ID；管理员为 0
	SessionVersion int64
	ExamGeneration int64
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
	if value.Role == "student" {
		payload += "|" + strconv.FormatInt(value.ExamGeneration, 10) + "|" + strconv.FormatInt(value.SessionVersion, 10)
	}
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
	if len(values) != 3 && len(values) != 5 {
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
	var generation, version int64
	if values[0] == "student" {
		// 升级前缺少场次或会话版本的学生 Cookie 需要重新登录；管理员会话保持兼容。
		if len(values) != 5 {
			return principal{}, false
		}
		generation, err = strconv.ParseInt(values[3], 10, 64)
		if err != nil || generation <= 0 {
			return principal{}, false
		}
		version, err = strconv.ParseInt(values[4], 10, 64)
		if err != nil || version <= 0 {
			return principal{}, false
		}
	}
	return principal{SessionVersion: version, Role: values[0], ID: id, ExamGeneration: generation}, true
}

func (m *sessionManager) sign(value string) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

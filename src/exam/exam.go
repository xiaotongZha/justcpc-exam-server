package exam

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"justcpc-exam-server/src/store"
)

var beijing = time.FixedZone("Asia/Shanghai", 8*60*60)

// 考试状态。
const (
	StateNotStarted = "not_started"
	StateRunning    = "running"
	StatePaused     = "paused"
	StateFinished   = "finished"
)

const bcryptCost = 8

var (
	ErrForbidden    = errors.New("permission denied")
	ErrExamNotOpen  = errors.New("exam is not running")
	ErrInvalidState = errors.New("invalid exam state transition")
)

type Service struct {
	Store             *store.Store
	StatementPassword string
	// Notify 在数据变更后回调（kind：exam / submission / contestant / audit），
	// 用于向长连接订阅者广播；由 web 层注入。
	Notify func(kind string)
}

// notify 发布一次变更信号；未注入回调时为空操作。
func (s Service) notify(kind string) {
	if s.Notify != nil {
		s.Notify(kind)
	}
}

type Exam struct {
	ID               int64   `json:"id"`
	Generation       int64   `json:"-"` // 每次导入递增，隔离不同场次的学生会话与自动状态迁移。
	ContestID        int64   `json:"contest_id"`
	Name             string  `json:"name"`
	Description      string  `json:"description"`
	StatementPDFPath string  `json:"statement_pdf_path,omitempty"`
	State            string  `json:"state"`
	StartedAt        *string `json:"started_at,omitempty"`
	FinishedAt       *string `json:"finished_at,omitempty"`
	ExamStartAt      string  `json:"exam_start_at"`
	ExamEndAt        string  `json:"exam_end_at"`
	CreatedAt        string  `json:"created_at"`
}

type Problem struct {
	ID             int64           `json:"id"`
	OJProblemID    int64           `json:"problem_id"`
	Label          string          `json:"label"`
	Title          string          `json:"title"`
	ScoreCents     int64           `json:"-"`
	Score          string          `json:"score"`
	ResourceLimits json.RawMessage `json:"resource_limits"`
	OrderIndex     int             `json:"order_index"`
}

type Contestant struct {
	ID             int64   `json:"id"`
	ExamGeneration int64   `json:"-"` // 与登录凭据在同一次查询中读取。
	StudentID      string  `json:"student_id"`
	Name           string  `json:"name"`
	Disabled       bool    `json:"disabled"`
	Finished       bool    `json:"finished"`
	FinishedAt     *string `json:"finished_at,omitempty"`
	IP             string  `json:"ip,omitempty"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

type Submission struct {
	ID           int64  `json:"id"`
	ContestantID int64  `json:"contestant_id"`
	StudentID    string `json:"student_id,omitempty"`
	Name         string `json:"name,omitempty"`
	ProblemID    int64  `json:"problem_id"`
	Label        string `json:"label,omitempty"`
	ProblemTitle string `json:"problem_title,omitempty"`
	Language     string `json:"language"`
	SourcePath   string `json:"-"`
	SubmittedAt  string `json:"submitted_at"`
	Source       string `json:"source,omitempty"`
	Seq          int64  `json:"seq,omitempty"`
}

// ---------- 考试 ----------

// Exam 读取考试状态，并按已设定的起止时间懒推进状态：
// 任意请求到达时立即完成边界切换（开考/结束），无需等待后台定时器。
func (s Service) Exam(ctx context.Context) (Exam, error) {
	item, err := s.exam(ctx)
	if err != nil {
		return item, err
	}
	return s.AutoAdvance(ctx, item)
}

func (s Service) exam(ctx context.Context) (Exam, error) {
	var item Exam
	var statement sql.NullString
	var started, finished sql.NullString
	err := s.Store.DB.QueryRowContext(ctx,
		`SELECT id,generation,COALESCE(contest_id,0),name,description,statement_pdf_path,state,started_at,finished_at,COALESCE(exam_start_at,''),COALESCE(exam_end_at,''),created_at FROM exam WHERE id=1`).
		Scan(&item.ID, &item.Generation, &item.ContestID, &item.Name, &item.Description, &statement, &item.State, &started, &finished, &item.ExamStartAt, &item.ExamEndAt, &item.CreatedAt)
	if err != nil {
		return item, err
	}
	item.StatementPDFPath = statement.String
	if started.Valid {
		item.StartedAt = &started.String
	}
	if finished.Valid {
		item.FinishedAt = &finished.String
	}
	return item, nil
}

// SetState 执行考试状态迁移并记录审计。reason 用于例外操作说明。
func (s Service) SetState(ctx context.Context, actor, action, reason string) (Exam, error) {
	next, err := stateFor(action)
	if err != nil {
		return Exam{}, err
	}
	item, err := store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (Exam, error) {
		var current string
		if err := tx.QueryRowContext(ctx, `SELECT state FROM exam WHERE id=1`).Scan(&current); err != nil {
			return Exam{}, err
		}
		if !allowedTransition(current, next) {
			return Exam{}, fmt.Errorf("%w: %s -> %s", ErrInvalidState, current, next)
		}
		now := store.Now()
		switch next {
		case StateRunning:
			_, err = tx.ExecContext(ctx, `UPDATE exam SET state=?, started_at=COALESCE(started_at,?), finished_at=NULL WHERE id=1`, next, now)
		case StateFinished:
			_, err = tx.ExecContext(ctx, `UPDATE exam SET state=?, finished_at=? WHERE id=1`, next, now)
		default:
			_, err = tx.ExecContext(ctx, `UPDATE exam SET state=? WHERE id=1`, next)
		}
		if err != nil {
			return Exam{}, err
		}
		if err := auditTx(ctx, tx, actor, "exam."+action, "exam", "1", map[string]any{"from": current, "to": next, "reason": reason}); err != nil {
			return Exam{}, err
		}
		item, err := scanExam(ctx, tx)
		if err != nil {
			return Exam{}, err
		}
		return item, nil
	})
	if err != nil {
		return Exam{}, err
	}
	s.notify("exam")
	return item, nil
}

func stateFor(action string) (string, error) {
	switch action {
	case "start":
		return StateRunning, nil
	case "pause":
		return StatePaused, nil
	case "resume":
		return StateRunning, nil
	case "finish":
		return StateFinished, nil
	}
	return "", fmt.Errorf("unknown exam action %q", action)
}

func allowedTransition(current, next string) bool {
	switch next {
	case StateRunning:
		return current == StateNotStarted || current == StatePaused
	case StatePaused:
		return current == StateRunning
	case StateFinished:
		return current == StateRunning || current == StatePaused || current == StateNotStarted
	}
	return false
}

// parseExamTime 接受到分钟或到秒的时间串，统一规整为 "YYYY-MM-DD HH:mm:00"。
func parseExamTime(value string) (time.Time, string, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{store.TimeLayout, "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, value, beijing); err == nil {
			return t, t.Format(store.TimeLayout), nil
		}
	}
	return time.Time{}, "", errors.New("时间格式应为 YYYY-MM-DD HH:mm")
}

// Schedule 由考试平台设定本场考试的开始与结束时间（精确到分钟）。
func (s Service) Schedule(ctx context.Context, actor, start, end string) (Exam, error) {
	startTime, start, err := parseExamTime(start)
	if err != nil {
		return Exam{}, fmt.Errorf("开始时间：%w", err)
	}
	endTime, end, err := parseExamTime(end)
	if err != nil {
		return Exam{}, fmt.Errorf("结束时间：%w", err)
	}
	if !endTime.After(startTime) {
		return Exam{}, errors.New("结束时间必须晚于开始时间")
	}
	if _, err := s.Store.DB.ExecContext(ctx, `UPDATE exam SET exam_start_at=?,exam_end_at=? WHERE id=1`, start, end); err != nil {
		return Exam{}, err
	}
	if err := s.Audit(ctx, actor, "exam.schedule", "exam", "1", map[string]any{"start": start, "end": end}); err != nil {
		return Exam{}, err
	}
	// s.Exam 会按新的起止时间懒推进状态，并在此后广播变更。
	exam, err := s.Exam(ctx)
	if err != nil {
		return exam, err
	}
	s.notify("exam")
	return exam, nil
}

// Abort 强行中止比赛：立即结束并清空已设定的起止时间，之后可重新设定时间再开赛。
func (s Service) Abort(ctx context.Context, actor, reason string) (Exam, error) {
	// 先按时间懒推进，避免边界时刻误判当前状态。
	if _, err := s.Exam(ctx); err != nil {
		return Exam{}, err
	}
	item, err := store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (Exam, error) {
		var current string
		if err := tx.QueryRowContext(ctx, `SELECT state FROM exam WHERE id=1`).Scan(&current); err != nil {
			return Exam{}, err
		}
		if current != StateRunning && current != StatePaused {
			return Exam{}, fmt.Errorf("%w：只有进行中/已暂停的比赛可以强行中止", ErrInvalidState)
		}
		now := store.Now()
		if _, err := tx.ExecContext(ctx,
			`UPDATE exam SET state=?, finished_at=?, exam_start_at=NULL, exam_end_at=NULL WHERE id=1`, StateFinished, now); err != nil {
			return Exam{}, err
		}
		if err := auditTx(ctx, tx, actor, "exam.abort", "exam", "1", map[string]any{"from": current, "reason": reason}); err != nil {
			return Exam{}, err
		}
		return scanExam(ctx, tx)
	})
	if err != nil {
		return Exam{}, err
	}
	s.notify("exam")
	return item, nil
}

// Restart 重新开始比赛：重置为未开始并设定新的起止时间；可选择清空先前提交。
func (s Service) Restart(ctx context.Context, actor string, clearSubmissions bool, start, end string) (Exam, error) {
	startTime, start, err := parseExamTime(start)
	if err != nil {
		return Exam{}, fmt.Errorf("开始时间：%w", err)
	}
	endTime, end, err := parseExamTime(end)
	if err != nil {
		return Exam{}, fmt.Errorf("结束时间：%w", err)
	}
	if !endTime.After(startTime) {
		return Exam{}, errors.New("结束时间必须晚于开始时间")
	}

	var removedIDs []int64
	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		if clearSubmissions {
			rows, err := tx.QueryContext(ctx, `SELECT id FROM submissions`)
			if err != nil {
				return struct{}{}, err
			}
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return struct{}{}, err
				}
				removedIDs = append(removedIDs, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return struct{}{}, err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM submissions`); err != nil {
				return struct{}{}, err
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE exam SET state='not_started', exam_start_at=?, exam_end_at=?, started_at=NULL, finished_at=NULL WHERE id=1`,
			start, end); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE contestants SET finished=0,finished_at=NULL,updated_at=?`, store.Now()); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, actor, "exam.restart", "exam", "1", map[string]any{
			"clear_submissions": clearSubmissions, "removed": len(removedIDs), "start": start, "end": end,
		})
	})
	if err != nil {
		return Exam{}, err
	}
	for _, id := range removedIDs {
		_ = os.RemoveAll(s.Store.Absolute(filepath.Join("submissions", strconv.FormatInt(id, 10))))
		_ = os.RemoveAll(s.Store.Absolute(filepath.Join("outputs", strconv.FormatInt(id, 10))))
	}
	if clearSubmissions {
		s.notify("submission")
	}
	s.notify("contestant")
	// s.Exam 会按新的起止时间懒推进状态，并在此后广播变更。
	exam, err := s.Exam(ctx)
	if err != nil {
		return exam, err
	}
	s.notify("exam")
	return exam, nil
}

// AutoAdvance 按设定时间自动切换状态：到开始时间进入进行中，到截止时间进入已结束。
// 手动操作（提前开始/结束、暂停）依旧可用；自动切换只补齐时间点。
func (s Service) AutoAdvance(ctx context.Context, exam Exam) (Exam, error) {
	if strings.TrimSpace(exam.ExamStartAt) == "" || strings.TrimSpace(exam.ExamEndAt) == "" {
		return exam, nil
	}
	start, err := time.ParseInLocation(store.TimeLayout, exam.ExamStartAt, beijing)
	if err != nil {
		return exam, nil
	}
	end, err := time.ParseInLocation(store.TimeLayout, exam.ExamEndAt, beijing)
	if err != nil {
		return exam, nil
	}
	now := time.Now().In(beijing)
	target := exam.State
	switch {
	case !now.Before(end):
		if exam.State == StateRunning || exam.State == StatePaused || exam.State == StateNotStarted {
			target = StateFinished
		}
	case !now.Before(start):
		if exam.State == StateNotStarted {
			target = StateRunning
		}
	}
	if target == exam.State {
		return exam, nil
	}
	action := "finish"
	reason := "到达截止时间，自动结束"
	if target == StateRunning {
		action = "start"
		reason = "到达开始时间，自动开始"
	}
	// 条件更新作为事务的第一条语句：旧快照不能覆盖新的时间安排或手动状态，
	// 多个请求同时到达时间边界时也只推进、审计和广播一次。
	changed := false
	item, err := store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (Exam, error) {
		query := `UPDATE exam SET state=?,finished_at=? WHERE id=1 AND generation=? AND state=? AND COALESCE(exam_start_at,'')=? AND COALESCE(exam_end_at,'')=?`
		if target == StateRunning {
			query = `UPDATE exam SET state=?,started_at=COALESCE(started_at,?),finished_at=NULL WHERE id=1 AND generation=? AND state=? AND COALESCE(exam_start_at,'')=? AND COALESCE(exam_end_at,'')=?`
		}
		result, err := tx.ExecContext(ctx, query, target, store.Now(), exam.Generation, exam.State, exam.ExamStartAt, exam.ExamEndAt)
		if err != nil {
			return Exam{}, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return Exam{}, err
		}
		changed = count != 0
		if changed {
			if err := auditTx(ctx, tx, "system", "exam."+action, "exam", "1", map[string]any{"from": exam.State, "to": target, "reason": reason}); err != nil {
				return Exam{}, err
			}
		}
		return scanExam(ctx, tx)
	})
	if err != nil {
		return Exam{}, err
	}
	if changed {
		s.notify("exam")
	}
	return item, nil
}

// RunAutoAdvance 周期性检查并按时间推进状态（s.Exam 内部完成切换与广播）。
func (s Service) RunAutoAdvance(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = s.Exam(ctx)
		}
	}
}

func scanExam(ctx context.Context, tx *sql.Tx) (Exam, error) {
	var item Exam
	var statement, started, finished sql.NullString
	err := tx.QueryRowContext(ctx,
		`SELECT id,generation,COALESCE(contest_id,0),name,description,statement_pdf_path,state,started_at,finished_at,COALESCE(exam_start_at,''),COALESCE(exam_end_at,''),created_at FROM exam WHERE id=1`).
		Scan(&item.ID, &item.Generation, &item.ContestID, &item.Name, &item.Description, &statement, &item.State, &started, &finished, &item.ExamStartAt, &item.ExamEndAt, &item.CreatedAt)
	if err != nil {
		return item, err
	}
	item.StatementPDFPath = statement.String
	if started.Valid {
		item.StartedAt = &started.String
	}
	if finished.Valid {
		item.FinishedAt = &finished.String
	}
	return item, nil
}

// ---------- 管理员 ----------

func (s Service) EnsureAdmin(ctx context.Context, username, password string) error {
	var count int
	if err := s.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	if username == "" || password == "" {
		return errors.New("first startup requires an administrator password (admin_password or JUSTCPC_EXAM_ADMIN_PASSWORD)")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return err
	}
	_, err = s.Store.DB.ExecContext(ctx,
		`INSERT INTO admin(id,username,password_hash,updated_at) VALUES(1,?,?,?)`, username, string(hash), store.Now())
	return err
}

func (s Service) AuthenticateAdmin(ctx context.Context, username, password string) error {
	var storedUser, hash string
	err := s.Store.DB.QueryRowContext(ctx, `SELECT username,password_hash FROM admin WHERE id=1`).Scan(&storedUser, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("administrator is not configured")
	}
	if err != nil {
		return err
	}
	if storedUser != username || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return errors.New("用户名或密码错误")
	}
	return nil
}

func (s Service) UpdateAdminPassword(ctx context.Context, actor, oldPassword, newPassword string) error {
	if newPassword == "" {
		return errors.New("新密码不能为空")
	}
	var hash string
	if err := s.Store.DB.QueryRowContext(ctx, `SELECT password_hash FROM admin WHERE id=1`).Scan(&hash); err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(oldPassword)) != nil {
		return errors.New("原密码错误")
	}
	next, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcryptCost)
	if err != nil {
		return err
	}
	if _, err := s.Store.DB.ExecContext(ctx, `UPDATE admin SET password_hash=?,updated_at=? WHERE id=1`, string(next), store.Now()); err != nil {
		return err
	}
	return s.Audit(ctx, actor, "admin.password", "admin", "1", map[string]any{})
}

// ---------- 题目 ----------

func (s Service) ListProblems(ctx context.Context) ([]Problem, error) {
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT id,COALESCE(oj_problem_id,0),label,title,score_cents,resource_limits_json,order_index FROM problems ORDER BY order_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Problem, 0)
	for rows.Next() {
		var item Problem
		var limits string
		if err := rows.Scan(&item.ID, &item.OJProblemID, &item.Label, &item.Title, &item.ScoreCents, &limits, &item.OrderIndex); err != nil {
			return nil, err
		}
		item.Score = formatScore(item.ScoreCents)
		item.ResourceLimits = json.RawMessage(limits)
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s Service) ProblemByLabel(ctx context.Context, label string) (Problem, error) {
	var item Problem
	var limits string
	err := s.Store.DB.QueryRowContext(ctx,
		`SELECT id,COALESCE(oj_problem_id,0),label,title,score_cents,resource_limits_json,order_index FROM problems WHERE label=?`,
		strings.ToUpper(strings.TrimSpace(label))).
		Scan(&item.ID, &item.OJProblemID, &item.Label, &item.Title, &item.ScoreCents, &limits, &item.OrderIndex)
	if err != nil {
		return item, err
	}
	item.Score = formatScore(item.ScoreCents)
	item.ResourceLimits = json.RawMessage(limits)
	return item, nil
}

// ---------- 考生 ----------

func (s Service) ListContestants(ctx context.Context) ([]Contestant, error) {
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT id,student_id,name,disabled,finished,finished_at,ip,created_at,updated_at FROM contestants ORDER BY student_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Contestant, 0)
	for rows.Next() {
		item, err := scanContestant(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s Service) Contestant(ctx context.Context, id int64) (Contestant, error) {
	return scanContestant(s.Store.DB.QueryRowContext(ctx,
		`SELECT id,student_id,name,disabled,finished,finished_at,ip,created_at,updated_at FROM contestants WHERE id=?`, id))
}

func (s Service) AuthenticateContestant(ctx context.Context, studentID, password string) (Contestant, error) {
	var item Contestant
	var hash string
	var finished sql.NullString
	err := s.Store.DB.QueryRowContext(ctx,
		`SELECT c.id,c.student_id,c.name,c.disabled,c.finished,c.finished_at,c.ip,c.created_at,c.updated_at,c.password_hash,e.generation FROM contestants c CROSS JOIN exam e WHERE c.student_id=? AND e.id=1`,
		strings.TrimSpace(studentID)).
		Scan(&item.ID, &item.StudentID, &item.Name, &item.Disabled, &item.Finished, &finished, &item.IP, &item.CreatedAt, &item.UpdatedAt, &hash, &item.ExamGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return Contestant{}, errors.New("学号或密码错误")
	}
	if err != nil {
		return Contestant{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return Contestant{}, errors.New("学号或密码错误")
	}
	if finished.Valid {
		item.FinishedAt = &finished.String
	}
	if item.Disabled {
		return Contestant{}, ErrDisabled
	}
	return item, nil
}

// StudentSessionValid 验证会话仍属于当前导入的考试，防止考生 ID 复用后串号。
func (s Service) StudentSessionValid(ctx context.Context, contestantID, generation int64) (bool, error) {
	var valid bool
	err := s.Store.DB.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM exam e JOIN contestants c ON c.id=? WHERE e.id=1 AND e.generation=?)`,
		contestantID, generation).Scan(&valid)
	return valid, err
}

func (s Service) AddContestant(ctx context.Context, actor, studentID, name, password, reason string) (Contestant, error) {
	studentID = strings.TrimSpace(studentID)
	name = strings.TrimSpace(name)
	if studentID == "" || name == "" {
		return Contestant{}, errors.New("学号与姓名不能为空")
	}
	if password == "" {
		return Contestant{}, errors.New("临时考生必须设置密码")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return Contestant{}, err
	}
	now := store.Now()
	var id int64
	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		result, err := tx.ExecContext(ctx,
			`INSERT INTO contestants(student_id,name,password_hash,disabled,finished,created_at,updated_at) VALUES(?,?,?,0,0,?,?)`,
			studentID, name, string(hash), now, now)
		if err != nil {
			return struct{}{}, fmt.Errorf("学号 %s 已存在或无效", studentID)
		}
		id, _ = result.LastInsertId()
		return struct{}{}, auditTx(ctx, tx, actor, "contestant.add", "contestant", strconv.FormatInt(id, 10),
			map[string]any{"student_id": studentID, "name": name, "reason": reason})
	})
	if err != nil {
		return Contestant{}, err
	}
	s.notify("contestant")
	return s.Contestant(ctx, id)
}

type ContestantUpdate struct {
	Name     string
	Password string
	Disabled *bool
	Finished *bool
	Reason   string
}

func (s Service) UpdateContestant(ctx context.Context, actor string, id int64, input ContestantUpdate) (Contestant, error) {
	item, err := store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (Contestant, error) {
		var current Contestant
		var finished sql.NullString
		if err := tx.QueryRowContext(ctx,
			`SELECT id,student_id,name,disabled,finished,finished_at,ip,created_at,updated_at FROM contestants WHERE id=?`, id).
			Scan(&current.ID, &current.StudentID, &current.Name, &current.Disabled, &current.Finished, &finished, &current.IP, &current.CreatedAt, &current.UpdatedAt); err != nil {
			return Contestant{}, err
		}
		if finished.Valid {
			current.FinishedAt = &finished.String
		}
		name := current.Name
		if strings.TrimSpace(input.Name) != "" {
			name = strings.TrimSpace(input.Name)
		}
		disabled := current.Disabled
		if input.Disabled != nil {
			disabled = *input.Disabled
		}
		finishedFlag := current.Finished
		if input.Finished != nil {
			finishedFlag = *input.Finished
		}
		changed := map[string]any{"reason": input.Reason}
		if _, err := tx.ExecContext(ctx, `UPDATE contestants SET name=?, disabled=?, finished=?, updated_at=? WHERE id=?`,
			name, boolInt(disabled), boolInt(finishedFlag), store.Now(), id); err != nil {
			return Contestant{}, err
		}
		if input.Password != "" {
			hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcryptCost)
			if err != nil {
				return Contestant{}, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE contestants SET password_hash=? WHERE id=?`, string(hash), id); err != nil {
				return Contestant{}, err
			}
			changed["password_reset"] = true
		}
		if input.Disabled != nil {
			changed["disabled"] = disabled
		}
		if input.Finished != nil {
			changed["finished"] = finishedFlag
		}
		if input.Name != "" {
			changed["name"] = name
		}
		if err := auditTx(ctx, tx, actor, "contestant.update", "contestant", strconv.FormatInt(id, 10), changed); err != nil {
			return Contestant{}, err
		}
		return current, nil
	})
	if err != nil {
		return Contestant{}, err
	}
	s.notify("contestant")
	return item, nil
}

// MarkContestantIP 记录最近登录 IP（用于现场排查，可为空）。
func (s Service) MarkContestantIP(ctx context.Context, id int64, ip string) {
	_, _ = s.Store.DB.ExecContext(ctx, `UPDATE contestants SET ip=? WHERE id=?`, ip, id)
}

// Rules 返回当前考生守则文本（每行一条）。
func (s Service) Rules(ctx context.Context) (string, error) {
	var value string
	err := s.Store.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='rules'`).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return store.DefaultRules, nil
	}
	return value, err
}

// SetRules 更新考生守则文本并记录审计。
func (s Service) SetRules(ctx context.Context, actor, value string) (string, error) {
	if _, err := s.Store.DB.ExecContext(ctx,
		`INSERT INTO settings(key,value) VALUES('rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, value); err != nil {
		return "", err
	}
	if err := s.Audit(ctx, actor, "exam.rules.update", "exam", "1", map[string]any{"bytes": len(value)}); err != nil {
		return "", err
	}
	return value, nil
}

// ---------- 审计 ----------

func (s Service) Audit(ctx context.Context, actor, action, objectType, objectID string, detail map[string]any) error {
	encoded, _ := json.Marshal(detail)
	_, err := s.Store.DB.ExecContext(ctx,
		`INSERT INTO audit_logs(actor,action,object_type,object_id,detail_json,created_at) VALUES(?,?,?,?,?,?)`,
		actor, action, objectType, objectID, string(encoded), store.Now())
	return err
}

func auditTx(ctx context.Context, tx *sql.Tx, actor, action, objectType, objectID string, detail map[string]any) error {
	encoded, _ := json.Marshal(detail)
	_, err := tx.ExecContext(ctx,
		`INSERT INTO audit_logs(actor,action,object_type,object_id,detail_json,created_at) VALUES(?,?,?,?,?,?)`,
		actor, action, objectType, objectID, string(encoded), store.Now())
	return err
}

type AuditLog struct {
	ID         int64  `json:"id"`
	Actor      string `json:"actor"`
	Action     string `json:"action"`
	ObjectType string `json:"object_type"`
	ObjectID   string `json:"object_id"`
	Detail     string `json:"detail_json"`
	CreatedAt  string `json:"created_at"`
}

func (s Service) AuditLogs(ctx context.Context, limit int) ([]AuditLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT id,actor,action,object_type,object_id,detail_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]AuditLog, 0)
	for rows.Next() {
		var item AuditLog
		if err := rows.Scan(&item.ID, &item.Actor, &item.Action, &item.ObjectType, &item.ObjectID, &item.Detail, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// ClearAuditLogs 清空全部审计日志，并留下一条清空记录。
func (s Service) ClearAuditLogs(ctx context.Context, actor string) error {
	_, err := store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_logs`).Scan(&count); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM audit_logs`); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, actor, "audit.clear", "audit", "0", map[string]any{"removed": count})
	})
	if err != nil {
		return err
	}
	s.notify("audit")
	return nil
}

// ---------- 工具 ----------

type scanner interface{ Scan(...any) error }

func scanContestant(row scanner) (Contestant, error) {
	var item Contestant
	var finished sql.NullString
	if err := row.Scan(&item.ID, &item.StudentID, &item.Name, &item.Disabled, &item.Finished, &finished, &item.IP, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	if finished.Valid {
		item.FinishedAt = &finished.String
	}
	return item, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// ParseScore 把分数字符串解析为"分×100"的整数。
func ParseScore(value string) (int64, error) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) > 2 || value == "" {
		return 0, fmt.Errorf("invalid score %q", value)
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole < 0 {
		return 0, fmt.Errorf("invalid score %q", value)
	}
	if len(parts) == 1 {
		return whole * 100, nil
	}
	if len(parts[1]) == 0 || len(parts[1]) > 2 {
		return 0, fmt.Errorf("score must have at most two decimal places")
	}
	fraction, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid score %q", value)
	}
	if len(parts[1]) == 1 {
		fraction *= 10
	}
	return whole*100 + fraction, nil
}

func formatScore(cents int64) string {
	whole := cents / 100
	fraction := cents % 100
	if fraction < 0 {
		fraction = -fraction
	}
	if fraction == 0 {
		return fmt.Sprintf("%d", whole)
	}
	if fraction%10 == 0 {
		return fmt.Sprintf("%d.%d", whole, fraction/10)
	}
	return fmt.Sprintf("%d.%02d", whole, fraction)
}

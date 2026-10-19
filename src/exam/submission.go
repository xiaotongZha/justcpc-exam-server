package exam

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"justcpc-exam-server/src/store"
)

var (
	ErrSourceTooLarge  = errors.New("源码超过大小限制")
	ErrInvalidLanguage = errors.New("语言必须是 cpp、java 或 python3")
	ErrFinished        = errors.New("您已交卷，无法登录或继续考试")
	ErrDisabled        = errors.New("账户已被禁用")
)

// 单份源码上限（固定值，不通过配置调整）。
const maxSourceBytes = 256 * 1024

func extension(language string) string {
	switch language {
	case "cpp":
		return "cpp"
	case "java":
		return "java"
	case "python3":
		return "py"
	}
	return ""
}

// Submit 先持久化新源码，再在事务中切换每人每题的有效提交；语言不参与分组。
func (s Service) Submit(ctx context.Context, contestantID int64, label, language, source string) (Submission, error) {
	examState, err := s.Exam(ctx)
	if err != nil {
		return Submission{}, err
	}
	if examState.State != StateRunning {
		return Submission{}, ErrExamNotOpen
	}
	language = strings.TrimSpace(language)
	if extension(language) == "" {
		return Submission{}, ErrInvalidLanguage
	}
	source = strings.ReplaceAll(source, "\r\n", "\n")
	if strings.TrimSpace(source) == "" {
		return Submission{}, errors.New("源码不能为空")
	}
	if len(source) > maxSourceBytes {
		return Submission{}, ErrSourceTooLarge
	}
	problem, err := s.ProblemByLabel(ctx, label)
	if err != nil {
		return Submission{}, errors.New("题号不存在")
	}
	contestant, err := s.Contestant(ctx, contestantID)
	if err != nil {
		return Submission{}, err
	}
	if contestant.Disabled {
		return Submission{}, ErrDisabled
	}
	if contestant.Finished {
		return Submission{}, ErrFinished
	}

	s.Store.SourceMu.Lock()
	defer s.Store.SourceMu.Unlock()
	root := s.Store.Absolute("submissions")
	if err := os.MkdirAll(root, 0700); err != nil {
		return Submission{}, err
	}
	dir, err := os.MkdirTemp(root, "code-")
	if err != nil {
		return Submission{}, err
	}
	relative := filepath.Join("submissions", filepath.Base(dir), "main."+extension(language))
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(dir)
		}
	}()
	if err := s.Store.WriteFile(relative, []byte(source)); err != nil {
		return Submission{}, err
	}

	now := store.Now()
	var id int64
	var oldPaths []string
	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		// 首先取得 SQLite 写锁，避免交卷、停考或导入与保存交错。
		if _, err := tx.ExecContext(ctx, `UPDATE exam SET generation=generation WHERE id=1`); err != nil {
			return struct{}{}, err
		}
		var currentState string
		var generation int64
		if err := tx.QueryRowContext(ctx, `SELECT state,generation FROM exam WHERE id=1`).Scan(&currentState, &generation); err != nil {
			return struct{}{}, err
		}
		if currentState != StateRunning || generation != examState.Generation {
			return struct{}{}, ErrExamNotOpen
		}
		var disabled, finished bool
		if err := tx.QueryRowContext(ctx, `SELECT disabled,finished FROM contestants WHERE id=?`, contestantID).Scan(&disabled, &finished); err != nil {
			return struct{}{}, err
		}
		if disabled {
			return struct{}{}, ErrDisabled
		}
		if finished {
			return struct{}{}, ErrFinished
		}
		rows, err := tx.QueryContext(ctx, `SELECT source_path FROM submissions WHERE contestant_id=? AND problem_id=?`, contestantID, problem.ID)
		if err != nil {
			return struct{}{}, err
		}
		for rows.Next() {
			var path string
			if err := rows.Scan(&path); err != nil {
				rows.Close()
				return struct{}{}, err
			}
			oldPaths = append(oldPaths, path)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return struct{}{}, err
		}
		result, err := tx.ExecContext(ctx,
			`INSERT INTO submissions(contestant_id,problem_id,language,source_path,submitted_at) VALUES(?,?,?,?,?)`,
			contestantID, problem.ID, language, relative, now)
		if err != nil {
			return struct{}{}, err
		}
		id, err = result.LastInsertId()
		if err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM submissions WHERE contestant_id=? AND problem_id=? AND id<>?`, contestantID, problem.ID, id); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, contestant.StudentID, "submission.create", "submission", strconv.FormatInt(id, 10),
			map[string]any{"label": problem.Label, "language": language, "bytes": len(source), "replaced": len(oldPaths)})
	})
	if err != nil {
		return Submission{}, err
	}
	committed = true
	for _, path := range oldPaths {
		if path == "" || path == relative {
			continue
		}
		if err := os.Remove(s.Store.Absolute(path)); err != nil && !os.IsNotExist(err) {
			// 新提交已经生效；清理失败不能向学生返回保存失败。
			fmt.Fprintf(os.Stderr, "清理已替换源码 %s: %v\n", path, err)
		}
		_ = os.Remove(filepath.Dir(s.Store.Absolute(path))) // 只删除空目录。
	}

	s.notify("submission")
	return Submission{ID: id, ContestantID: contestantID, ProblemID: problem.ID, Label: problem.Label, Language: language, SourcePath: relative, SubmittedAt: now}, nil
}

// LastByProblem 返回当前有效提交；兼容旧数据中的历史记录，按时间/ID 取最新。
func (s Service) LastByProblem(ctx context.Context, contestantID int64) (map[string]Submission, error) {
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT s.id,s.contestant_id,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at
		 FROM submissions s JOIN problems p ON p.id=s.problem_id
		 WHERE s.contestant_id=? ORDER BY s.submitted_at DESC, s.id DESC`, contestantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]Submission{}
	for rows.Next() {
		var item Submission
		if err := rows.Scan(&item.ID, &item.ContestantID, &item.ProblemID, &item.Label, &item.ProblemTitle, &item.Language, &item.SourcePath, &item.SubmittedAt); err != nil {
			return nil, err
		}
		if _, exists := result[item.Label]; !exists {
			result[item.Label] = item
		}
	}
	return result, rows.Err()
}

func (s Service) ListByContestant(ctx context.Context, contestantID int64) ([]Submission, error) {
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT s.id,s.contestant_id,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at
		 FROM submissions s JOIN problems p ON p.id=s.problem_id
		 WHERE s.contestant_id=? AND NOT EXISTS (SELECT 1 FROM submissions newer WHERE newer.contestant_id=s.contestant_id AND newer.problem_id=s.problem_id AND (newer.submitted_at>s.submitted_at OR (newer.submitted_at=s.submitted_at AND newer.id>s.id))) ORDER BY s.id DESC`, contestantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Submission, 0)
	for rows.Next() {
		var item Submission
		if err := rows.Scan(&item.ID, &item.ContestantID, &item.ProblemID, &item.Label, &item.ProblemTitle, &item.Language, &item.SourcePath, &item.SubmittedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// SubmissionSource 读取源码。调用方负责权限检查。
func (s Service) SubmissionSource(ctx context.Context, id int64) (Submission, string, error) {
	s.Store.SourceMu.RLock()
	defer s.Store.SourceMu.RUnlock()
	var item Submission
	err := s.Store.DB.QueryRowContext(ctx,
		`SELECT s.id,s.contestant_id,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at
		 FROM submissions s JOIN problems p ON p.id=s.problem_id WHERE s.id=?`, id).
		Scan(&item.ID, &item.ContestantID, &item.ProblemID, &item.Label, &item.ProblemTitle, &item.Language, &item.SourcePath, &item.SubmittedAt)
	if err != nil {
		return item, "", err
	}
	data, err := os.ReadFile(s.Store.Absolute(item.SourcePath))
	if err != nil {
		return item, "", err
	}
	item.Source = string(data)
	return item, item.Source, nil
}

type SubmissionFilter struct {
	StudentID string
	Label     string
	Language  string
	Limit     int
}

func submissionQuery(filter SubmissionFilter) (string, []any) {
	query := `FROM submissions s
		JOIN contestants c ON c.id=s.contestant_id
		JOIN problems p ON p.id=s.problem_id WHERE NOT EXISTS (SELECT 1 FROM submissions newer WHERE newer.contestant_id=s.contestant_id AND newer.problem_id=s.problem_id AND (newer.submitted_at>s.submitted_at OR (newer.submitted_at=s.submitted_at AND newer.id>s.id)))`
	args := []any{}
	if filter.StudentID != "" {
		query += ` AND c.student_id=?`
		args = append(args, filter.StudentID)
	}
	if filter.Label != "" {
		query += ` AND p.label=?`
		args = append(args, strings.ToUpper(filter.Label))
	}
	if filter.Language != "" {
		query += ` AND s.language=?`
		args = append(args, filter.Language)
	}
	return query, args
}

func (s Service) ListSubmissions(ctx context.Context, filter SubmissionFilter) ([]Submission, error) {
	from, args := submissionQuery(filter)
	query := `SELECT s.id,s.contestant_id,c.student_id,c.name,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at ` + from
	query += ` ORDER BY s.id DESC`
	limit := filter.Limit
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	query += ` LIMIT ?`
	args = append(args, limit)

	rows, err := s.Store.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Submission, 0)
	for rows.Next() {
		var item Submission
		if err := rows.Scan(&item.ID, &item.ContestantID, &item.StudentID, &item.Name, &item.ProblemID, &item.Label, &item.ProblemTitle, &item.Language, &item.SourcePath, &item.SubmittedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// EarlySubmit 记录考生提前交卷。
func (s Service) EarlySubmit(ctx context.Context, contestantID int64) (Contestant, error) {
	examState, err := s.Exam(ctx)
	if err != nil {
		return Contestant{}, err
	}
	if examState.State != StateRunning {
		return Contestant{}, ErrExamNotOpen
	}
	contestant, err := s.Contestant(ctx, contestantID)
	if err != nil {
		return Contestant{}, err
	}
	now := store.Now()
	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		if _, err := tx.ExecContext(ctx, `UPDATE contestants SET finished=1,session_version=session_version+1,finished_at=?,updated_at=? WHERE id=?`, now, now, contestantID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, contestant.StudentID, "contestant.early_submit", "contestant", strconv.FormatInt(contestantID, 10),
			map[string]any{})
	})
	if err != nil {
		return Contestant{}, err
	}
	contestant.Finished = true
	contestant.FinishedAt = &now
	s.notify("contestant")
	return contestant, nil
}

func (s Service) SubmissionCount(ctx context.Context) (int, error) {
	var count int
	err := s.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT 1 FROM submissions GROUP BY contestant_id,problem_id)`).Scan(&count)
	return count, err
}

func (s Service) CountsByProblem(ctx context.Context) (map[string]int, error) {
	rows, err := s.Store.DB.QueryContext(ctx,
		`SELECT p.label, COUNT(DISTINCT s.contestant_id) FROM submissions s JOIN problems p ON p.id=s.problem_id GROUP BY p.label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]int{}
	for rows.Next() {
		var label string
		var count int
		if err := rows.Scan(&label, &count); err != nil {
			return nil, err
		}
		result[label] = count
	}
	return result, rows.Err()
}

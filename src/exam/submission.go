package exam

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"justcpc-exam-server/src/store"
)

var (
	ErrSourceTooLarge  = errors.New("源码超过大小限制")
	ErrInvalidLanguage = errors.New("语言必须是 cpp、java 或 python3")
	ErrFinished        = errors.New("您已交卷，无法继续提交")
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

// Submit 保存一次提交。仅考试进行中允许；保留全部历史，不覆盖旧提交。
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

	now := store.Now()
	var id int64
	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		result, err := tx.ExecContext(ctx,
			`INSERT INTO submissions(contestant_id,problem_id,language,source_path,submitted_at) VALUES(?,?,?,?,?)`,
			contestantID, problem.ID, language, "", now)
		if err != nil {
			return struct{}{}, err
		}
		id, _ = result.LastInsertId()
		relative := filepath.Join("submissions", strconv.FormatInt(id, 10), "main."+extension(language))
		if _, err := tx.ExecContext(ctx, `UPDATE submissions SET source_path=? WHERE id=?`, relative, id); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, contestant.StudentID, "submission.create", "submission", strconv.FormatInt(id, 10),
			map[string]any{"label": problem.Label, "language": language, "bytes": len(source)})
	})
	if err != nil {
		return Submission{}, err
	}
	relative := filepath.Join("submissions", strconv.FormatInt(id, 10), "main."+extension(language))
	if err := s.Store.WriteFile(relative, []byte(source)); err != nil {
		_, _ = s.Store.DB.ExecContext(ctx, `DELETE FROM submissions WHERE id=?`, id)
		return Submission{}, err
	}
	s.notify("submission")
	return Submission{ID: id, ContestantID: contestantID, ProblemID: problem.ID, Label: problem.Label, Language: language, SourcePath: relative, SubmittedAt: now}, nil
}

// LastByProblem 返回该考生每题的最后一次提交（不覆盖历史，按时间/ID 取最新）。
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
		 WHERE s.contestant_id=? ORDER BY s.id DESC`, contestantID)
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

func (s Service) ListSubmissions(ctx context.Context, filter SubmissionFilter) ([]Submission, error) {
	query := `SELECT s.id,s.contestant_id,c.student_id,c.name,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at
		FROM submissions s
		JOIN contestants c ON c.id=s.contestant_id
		JOIN problems p ON p.id=s.problem_id WHERE 1=1`
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
func (s Service) EarlySubmit(ctx context.Context, contestantID int64, reason string) (Contestant, error) {
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
		if _, err := tx.ExecContext(ctx, `UPDATE contestants SET finished=1,finished_at=?,updated_at=? WHERE id=?`, now, now, contestantID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, auditTx(ctx, tx, contestant.StudentID, "contestant.early_submit", "contestant", strconv.FormatInt(contestantID, 10),
			map[string]any{"reason": reason})
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
	err := s.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM submissions`).Scan(&count)
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

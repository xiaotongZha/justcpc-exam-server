package exam

import (
	"context"
	"database/sql"
	"strings"
)

type PageRequest struct {
	Page     int
	PageSize int
}
type Page[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

// readPage counts and reads from one snapshot so concurrent submissions do not
// make the displayed total disagree with the returned rows.
func readPage[T any](ctx context.Context, db *sql.DB, request PageRequest, columns, from, order string, args []any, scan func(scanner) (T, error)) (Page[T], error) {
	result := Page[T]{Items: make([]T, 0), Page: request.Page, PageSize: request.PageSize}
	if result.Page < 1 {
		result.Page = 1
	}
	if result.PageSize < 1 {
		result.PageSize = 20
	}
	if result.PageSize > 100 {
		result.PageSize = 100
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) "+from, args...).Scan(&result.Total); err != nil {
		return result, err
	}
	pages := (result.Total + result.PageSize - 1) / result.PageSize
	if pages < 1 {
		pages = 1
	}
	if result.Page > pages {
		result.Page = pages
	}
	values := append(append([]any{}, args...), result.PageSize, (result.Page-1)*result.PageSize)
	rows, err := tx.QueryContext(ctx, "SELECT "+columns+" "+from+" ORDER BY "+order+" LIMIT ? OFFSET ?", values...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if err = rows.Close(); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s Service) ContestantsPage(ctx context.Context, request PageRequest, query, status string) (Page[Contestant], error) {
	from := "FROM contestants WHERE 1=1"
	args := []any{}
	if query = strings.TrimSpace(query); query != "" {
		from += ` AND instr(lower(student_id || ' ' || name),lower(?))>0`
		args = append(args, query)
	}
	switch status {
	case "disabled":
		from += " AND disabled=1"
	case "finished":
		from += " AND finished=1"
	case "normal":
		from += " AND disabled=0 AND finished=0"
	}
	return readPage(ctx, s.Store.DB, request, "id,student_id,name,disabled,finished,finished_at,ip,created_at,updated_at", from, "student_id,id", args, scanContestant)
}
func (s Service) SubmissionsPage(ctx context.Context, request PageRequest, filter SubmissionFilter) (Page[Submission], error) {
	from, args := submissionQuery(filter)
	return readPage(ctx, s.Store.DB, request, "s.id,s.contestant_id,c.student_id,c.name,s.problem_id,p.label,p.title,s.language,s.source_path,s.submitted_at", from, "s.id DESC", args, func(row scanner) (Submission, error) {
		var item Submission
		err := row.Scan(&item.ID, &item.ContestantID, &item.StudentID, &item.Name, &item.ProblemID, &item.Label, &item.ProblemTitle, &item.Language, &item.SourcePath, &item.SubmittedAt)
		return item, err
	})
}
func (s Service) AuditPage(ctx context.Context, request PageRequest) (Page[AuditLog], error) {
	return readPage(ctx, s.Store.DB, request, "id,actor,action,object_type,object_id,detail_json,created_at", "FROM audit_logs", "id DESC", nil, func(row scanner) (AuditLog, error) {
		var item AuditLog
		err := row.Scan(&item.ID, &item.Actor, &item.Action, &item.ObjectType, &item.ObjectID, &item.Detail, &item.CreatedAt)
		return item, err
	})
}

package exam

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"justcpc-exam-server/src/store"
)

type problemSpec struct {
	ProblemID int64           `json:"problem_id"`
	Label     string          `json:"label"`
	Title     string          `json:"title"`
	Score     string          `json:"score"`
	Limits    json.RawMessage `json:"resource_limits"`
}

type manifest struct {
	ContestID   int64         `json:"contest_id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Problems    []problemSpec `json:"problems"`
}

type contestantInput struct {
	StudentID string
	Name      string
	Password  string
}

type packageData struct {
	manifest    manifest
	statement   []byte
	contestants []contestantInput
}

// Import 读取并校验 Online Judge 导出的考试包，替换当前考试数据。
// 包结构：contest.json、statement.pdf、contestants.csv（题目按 problem_id 引用，不含测试数据）。
func (s Service) Import(ctx context.Context, actor string, archive []byte) (Exam, error) {
	data, err := readPackage(archive)
	if err != nil {
		return Exam{}, err
	}

	prepared := make([]struct {
		studentID string
		name      string
		hash      string
	}, 0, len(data.contestants))
	for _, item := range data.contestants {
		password := item.Password
		if password == "" {
			password = item.StudentID
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
		if err != nil {
			return Exam{}, err
		}
		prepared = append(prepared, struct {
			studentID string
			name      string
			hash      string
		}{item.StudentID, item.Name, string(hash)})
	}

	_, err = store.WithTx(ctx, s.Store.DB, func(tx *sql.Tx) (struct{}, error) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM submissions`); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM contestants`); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM problems`); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE exam SET contest_id=?,name=?,description=?,exam_start_at=NULL,exam_end_at=NULL,statement_pdf_path=NULL,state='not_started',started_at=NULL,finished_at=NULL WHERE id=1`,
			data.manifest.ContestID, data.manifest.Name, data.manifest.Description); err != nil {
			return struct{}{}, err
		}
		for index, item := range data.manifest.Problems {
			score, err := ParseScore(item.Score)
			if err != nil {
				return struct{}{}, fmt.Errorf("contest.json：题目 %s：%w", item.Label, err)
			}
			limits := item.Limits
			if len(limits) == 0 {
				limits = json.RawMessage(`{}`)
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO problems(oj_problem_id,label,title,score_cents,resource_limits_json,order_index) VALUES(?,?,?,?,?,?)`,
				item.ProblemID, item.Label, item.Title, score, string(limits), index); err != nil {
				return struct{}{}, err
			}
		}
		for _, item := range prepared {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO contestants(student_id,name,password_hash,disabled,finished,created_at,updated_at) VALUES(?,?,?,0,0,?,?)`,
				item.studentID, item.name, item.hash, store.Now(), store.Now()); err != nil {
				return struct{}{}, fmt.Errorf("写入考生 %s：%w", item.studentID, err)
			}
		}
		return struct{}{}, auditTx(ctx, tx, actor, "exam.import", "exam", "1", map[string]any{
			"name": data.manifest.Name, "problems": len(data.manifest.Problems), "contestants": len(prepared),
		})
	})
	if err != nil {
		return Exam{}, err
	}
	// 提交记录已整体清空，删除对应的源码文件，避免新提交复用旧文件。
	clearDirectory(s.Store.Absolute("submissions"))

	statementPath := filepath.Join("contest-statements", "statement.pdf")
	if err := s.Store.WriteFile(statementPath, data.statement); err != nil {
		return Exam{}, err
	}
	if _, err := s.Store.DB.ExecContext(ctx, `UPDATE exam SET statement_pdf_path=? WHERE id=1`, statementPath); err != nil {
		return Exam{}, err
	}
	exam, err := s.Exam(ctx)
	if err != nil {
		return exam, err
	}
	s.notify("submission")
	s.notify("contestant")
	s.notify("exam")
	return exam, nil
}

// clearDirectory 删除目录下的全部内容（不删除目录本身）。
func clearDirectory(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
	}
}

func readPackage(archive []byte) (packageData, error) {
	if len(archive) == 0 {
		return packageData{}, errors.New("考试包为空")
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return packageData{}, fmt.Errorf("读取 ZIP 失败：%w", err)
	}
	files := map[string][]byte{}
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name, "/") || strings.Contains(entry.Name, "../") || files[entry.Name] != nil {
			return packageData{}, fmt.Errorf("非法路径 %q", entry.Name)
		}
		input, err := entry.Open()
		if err != nil {
			return packageData{}, err
		}
		content, err := io.ReadAll(io.LimitReader(input, 1<<30))
		input.Close()
		if err != nil {
			return packageData{}, err
		}
		files[entry.Name] = content
	}

	var data packageData
	manifestBytes, ok := files["contest.json"]
	if !ok {
		return data, errors.New("包缺少 contest.json")
	}
	if err := json.Unmarshal(manifestBytes, &data.manifest); err != nil {
		return data, fmt.Errorf("contest.json 无法解析：%w", err)
	}
	if strings.TrimSpace(data.manifest.Name) == "" || len(data.manifest.Problems) == 0 {
		return data, errors.New("contest.json 必须包含 name 和 problems")
	}
	labels := map[string]bool{}
	for i, item := range data.manifest.Problems {
		expected := string(rune('A' + i))
		if item.Label != expected || labels[item.Label] || strings.TrimSpace(item.Title) == "" {
			return data, fmt.Errorf("contest.json 第 %d 个题目 label 非法（应为 %s）", i+1, expected)
		}
		if item.ProblemID <= 0 {
			return data, fmt.Errorf("contest.json 题目 %s 缺少平台题目 ID", item.Label)
		}
		if _, err := ParseScore(item.Score); err != nil {
			return data, fmt.Errorf("contest.json 题目 %s：%w", item.Label, err)
		}
		labels[item.Label] = true
	}

	statement, ok := files["statement.pdf"]
	if !ok || len(statement) == 0 {
		return data, errors.New("包缺少 statement.pdf")
	}
	data.statement = statement

	csvBytes, ok := files["contestants.csv"]
	if !ok {
		return data, errors.New("包缺少 contestants.csv")
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(csvBytes), "\ufeff"))).ReadAll()
	if err != nil {
		return data, fmt.Errorf("contestants.csv：%w", err)
	}
	if len(rows) < 1 || len(rows[0]) < 2 || rows[0][0] != "student_id" || rows[0][1] != "name" {
		return data, errors.New("contestants.csv 表头必须是 student_id,name[,password]")
	}
	students := map[string]bool{}
	for _, row := range rows[1:] {
		if len(row) < 2 || strings.TrimSpace(row[0]) == "" || strings.TrimSpace(row[1]) == "" || students[row[0]] {
			return data, errors.New("contestants.csv 存在非法或重复的考生")
		}
		students[row[0]] = true
		password := ""
		if len(row) >= 3 {
			password = strings.TrimSpace(row[2])
		}
		data.contestants = append(data.contestants, contestantInput{row[0], row[1], password})
	}
	if len(data.contestants) == 0 {
		return data, errors.New("contestants.csv 没有考生")
	}

	for path := range files {
		switch path {
		case "contest.json", "statement.pdf", "contestants.csv":
		default:
			return data, fmt.Errorf("包中存在多余文件 %s（本题库仅接受 OJ 导出的考试包）", path)
		}
	}
	return data, nil
}

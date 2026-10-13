package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const TimeLayout = "2006-01-02 15:04:05"

var beijing = time.FixedZone("Asia/Shanghai", 8*60*60)

// DefaultRules 是首次运行时写入的考生守则（每行一条，可在管理端修改）。
const DefaultRules = `请核对右上角姓名与学号，如有误立即举手示意管理员。
本系统仅用于发放题面与收集代码，不显示对错、不显示分数；提交仅表示已保存。
支持语言：C++、Java、Python 3。每题以最后一次提交作为赛后评测对象，历史提交均保留。
在题目列表点击「作答」进入提交页，选择题目与语言后粘贴源码提交。
禁止访问互联网、使用通讯工具或与他人交流，禁止干扰考试系统与服务器。
「提前交卷」不可撤销，交卷后无法再提交代码，请谨慎操作。
遇到系统异常请举手联系现场管理员，不要自行刷新或关闭页面。`

// Store 负责 SQLite 迁移、事务与本地文件目录。
type Store struct {
	DB       *sql.DB
	DataRoot string
}

func Open(databasePath, dataRoot string) (*Store, error) {
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	dataRoot = absoluteDataRoot
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	if err := os.MkdirAll(dataRoot, 0700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	db, err := sql.Open("sqlite", databasePath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	store := &Store{DB: db, DataRoot: dataRoot}
	if err := store.Migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.DB.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS exam (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			name TEXT NOT NULL DEFAULT '',
			description TEXT NOT NULL DEFAULT '',
			statement_pdf_path TEXT,
			state TEXT NOT NULL DEFAULT 'not_started'
				CHECK(state IN ('not_started','running','paused','finished','archived')),
			started_at TEXT,
			finished_at TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS problems (
			id INTEGER PRIMARY KEY,
			label TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			score_cents INTEGER NOT NULL DEFAULT 0,
			resource_limits_json TEXT NOT NULL DEFAULT '{}',
			order_index INTEGER NOT NULL,
			testdata_path TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS contestants (
			id INTEGER PRIMARY KEY,
			student_id TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			disabled INTEGER NOT NULL DEFAULT 0,
			finished INTEGER NOT NULL DEFAULT 0,
			finished_at TEXT,
			ip TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS submissions (
			id INTEGER PRIMARY KEY,
			contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
			problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
			language TEXT NOT NULL CHECK(language IN ('cpp','java','python3')),
			source_path TEXT NOT NULL,
			submitted_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS submissions_lookup_idx
			ON submissions(contestant_id, problem_id, submitted_at DESC, id DESC)`,
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id INTEGER PRIMARY KEY,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			object_type TEXT NOT NULL,
			object_id TEXT NOT NULL DEFAULT '',
			detail_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS admin (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			username TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC)`,
	}
	for _, statement := range statements {
		if _, err := s.DB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("run migration: %w", err)
		}
	}
	if _, err := s.DB.ExecContext(ctx,
		`INSERT OR IGNORE INTO settings(key,value) VALUES('rules',?)`, DefaultRules); err != nil {
		return fmt.Errorf("seed default rules: %w", err)
	}
	_, err := s.DB.ExecContext(ctx,
		`INSERT OR IGNORE INTO exam(id,name,description,state,created_at) VALUES(1,'','','not_started',?)`,
		Now())
	if err != nil {
		return fmt.Errorf("ensure exam row: %w", err)
	}
	for _, column := range []string{
		`ALTER TABLE exam ADD COLUMN contest_id INTEGER`,
		`ALTER TABLE exam ADD COLUMN exam_start_at TEXT`,
		`ALTER TABLE exam ADD COLUMN exam_end_at TEXT`,
		`ALTER TABLE problems ADD COLUMN oj_problem_id INTEGER`,
	} {
		if _, err := s.DB.ExecContext(ctx, column); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("alter table: %w", err)
		}
	}
	return nil
}

func Now() string { return time.Now().In(beijing).Format(TimeLayout) }

func NowAfter(duration time.Duration) string {
	return time.Now().In(beijing).Add(duration).Format(TimeLayout)
}

func WithTx[T any](ctx context.Context, db *sql.DB, fn func(*sql.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return zero, err
	}
	value, err := fn(tx)
	if err != nil {
		_ = tx.Rollback()
		return zero, err
	}
	if err := tx.Commit(); err != nil {
		return zero, err
	}
	return value, nil
}

// Absolute 返回 data/store 下相对路径对应的绝对路径。
func (s *Store) Absolute(relative string) string { return filepath.Join(s.DataRoot, "store", relative) }

func (s *Store) EnsureLayout() error {
	for _, relative := range []string{"contest-statements", "submissions", "imports"} {
		if err := os.MkdirAll(s.Absolute(relative), 0700); err != nil {
			return fmt.Errorf("create %s: %w", relative, err)
		}
	}
	return nil
}

// WriteFile 原子写入文件：先写临时文件再 rename。
func (s *Store) WriteFile(relative string, data []byte) error {
	path := s.Absolute(relative)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

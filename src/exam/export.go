package exam

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"
	"time"

	"justcpc-exam-server/src/store"
)

type submissionProblem struct {
	ProblemID int64  `json:"problem_id"`
	Label     string `json:"label"`
	Title     string `json:"title"`
	Score     string `json:"score"`
}

type submissionManifest struct {
	PackageType string              `json:"package_type"`
	ContestID   int64               `json:"contest_id"`
	Name        string              `json:"name"`
	Problems    []submissionProblem `json:"problems"`
}

type ExportResult struct {
	FileName        string `json:"file_name"`
	GeneratedAt     string `json:"generated_at"`
	ContestName     string `json:"contest_name"`
	SubmissionCount int    `json:"submission_count"`
	ContestantCount int    `json:"contestant_count"`
	ProblemCount    int    `json:"problem_count"`
}

// Export 生成提交包：contest.json（题目 ID 引用）+ contestants.csv（最终名单）+ submissions/。
// 每题每人只导出最后一次提交源码，不含测试数据与题面；由浏览器直接下载，不在系统内存储。
func (s Service) Export(ctx context.Context, actor string) (ExportResult, []byte, error) {
	s.Store.SourceMu.RLock()
	defer s.Store.SourceMu.RUnlock()
	examState, err := s.Exam(ctx)
	if err != nil {
		return ExportResult{}, nil, err
	}
	if examState.Name == "" {
		return ExportResult{}, nil, fmt.Errorf("尚未导入考试包")
	}
	if examState.State == StateNotStarted {
		return ExportResult{}, nil, fmt.Errorf("考试尚未开始，无法导出提交包")
	}
	problems, err := s.ListProblems(ctx)
	if err != nil {
		return ExportResult{}, nil, err
	}
	contestants, err := s.ListContestants(ctx)
	if err != nil {
		return ExportResult{}, nil, err
	}

	type lastSubmission struct {
		language string
		source   []byte
	}
	byContestant := make(map[int64]map[string]lastSubmission)
	submissionCount := 0
	for _, contestant := range contestants {
		last, err := s.LastByProblem(ctx, contestant.ID)
		if err != nil {
			return ExportResult{}, nil, err
		}
		byContestant[contestant.ID] = map[string]lastSubmission{}
		for label, submission := range last {
			source, err := os.ReadFile(s.Store.Absolute(submission.SourcePath))
			if err != nil {
				return ExportResult{}, nil, fmt.Errorf("考生 %s 题目 %s 的源码缺失", contestant.StudentID, label)
			}
			byContestant[contestant.ID][label] = lastSubmission{language: submission.Language, source: source}
			submissionCount++
		}
	}

	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	write := func(name string, value []byte) error {
		file, err := archive.Create(name)
		if err != nil {
			return err
		}
		_, err = file.Write(value)
		return err
	}

	manifest := submissionManifest{PackageType: "submissions", ContestID: examState.ContestID, Name: examState.Name}
	for _, item := range problems {
		manifest.Problems = append(manifest.Problems, submissionProblem{
			ProblemID: item.OJProblemID, Label: item.Label, Title: item.Title, Score: item.Score,
		})
	}
	manifestData, _ := json.Marshal(manifest)
	if err := write("contest.json", manifestData); err != nil {
		return ExportResult{}, nil, err
	}

	var contestantsBuffer bytes.Buffer
	contestantsBuffer.Write([]byte{0xef, 0xbb, 0xbf})
	writer := csv.NewWriter(&contestantsBuffer)
	_ = writer.Write([]string{"student_id", "name"})
	for _, contestant := range contestants {
		_ = writer.Write([]string{contestant.StudentID, contestant.Name})
	}
	writer.Flush()
	if err := write("contestants.csv", contestantsBuffer.Bytes()); err != nil {
		return ExportResult{}, nil, err
	}

	for _, contestant := range contestants {
		last := byContestant[contestant.ID]
		for _, item := range problems {
			entry, ok := last[item.Label]
			if !ok {
				continue
			}
			target := path.Join("submissions", contestant.StudentID, item.Label, "source."+extension(entry.language))
			if err := write(target, entry.source); err != nil {
				return ExportResult{}, nil, err
			}
		}
	}

	if err := archive.Close(); err != nil {
		return ExportResult{}, nil, err
	}

	timestamp := time.Now().Format("20060102_150405")
	safeName := strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '-'
		}
		return r
	}, examState.Name)
	nameRunes := []rune(strings.Trim(safeName, " ."))
	if len(nameRunes) > 64 {
		nameRunes = nameRunes[:64]
	}
	fileName := fmt.Sprintf("提交包-%s-%d-%s.zip", string(nameRunes), examState.ContestID, timestamp)
	result := ExportResult{
		FileName:        fileName,
		GeneratedAt:     store.Now(),
		ContestName:     examState.Name,
		SubmissionCount: submissionCount,
		ContestantCount: len(contestants),
		ProblemCount:    len(problems),
	}
	if err := s.Audit(ctx, actor, "exam.export", "exam", "1", map[string]any{
		"file": fileName, "submissions": submissionCount, "contestants": len(contestants),
	}); err != nil {
		return result, buffer.Bytes(), err
	}
	return result, buffer.Bytes(), nil
}

package web

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"justcpc-exam-server/src/exam"
)

func (s Server) adminLogin(c *gin.Context) {
	if !s.limiter.allow("admin-login:"+clientIP(c), 10, time.Minute) {
		fail(c, errTooMany)
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !bindJSON(c, &input) {
		return
	}
	if err := s.Exam.AuthenticateAdmin(c, input.Username, input.Password); err != nil {
		fail(c, err)
		return
	}
	s.sessions.set(c.Writer, adminCookie, principal{Role: "admin"})
	c.JSON(http.StatusOK, gin.H{"role": "admin", "username": input.Username})
}

func (s Server) adminLogout(c *gin.Context) {
	s.sessions.clear(c.Writer, adminCookie)
	c.Status(http.StatusNoContent)
}

func (s Server) adminMe(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"role": "admin"})
}

func (s Server) adminStatus(c *gin.Context) {
	examState, err := s.Exam.Exam(c)
	if err != nil {
		fail(c, err)
		return
	}
	problems, err := s.Exam.ListProblems(c)
	if err != nil {
		fail(c, err)
		return
	}
	contestants, err := s.Exam.ListContestants(c)
	if err != nil {
		fail(c, err)
		return
	}
	submissionTotal, err := s.Exam.SubmissionCount(c)
	if err != nil {
		fail(c, err)
		return
	}
	byProblem, err := s.Exam.CountsByProblem(c)
	if err != nil {
		fail(c, err)
		return
	}
	recent, err := s.Exam.ListSubmissions(c, exam.SubmissionFilter{Limit: 15})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"exam":              examState,
		"server_time":       examTime(),
		"online":            s.activity.count(5 * time.Minute),
		"problem_count":     len(problems),
		"contestant_count":  len(contestants),
		"submission_count":  submissionTotal,
		"submissions_by_problem": byProblem,
		"recent":            recent,
	})
}

func (s Server) adminGetRules(c *gin.Context) {
	rules, err := s.Exam.Rules(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (s Server) adminUpdateRules(c *gin.Context) {
	var input struct {
		Rules string `json:"rules"`
	}
	if !bindJSON(c, &input) {
		return
	}
	rules, err := s.Exam.SetRules(c, "admin", input.Rules)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (s Server) adminChecks(c *gin.Context) {
	checks, err := s.Exam.Checks(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, checks)
}

func (s Server) adminContestants(c *gin.Context) {
	items, err := s.Exam.ListContestants(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (s Server) adminAddContestant(c *gin.Context) {
	var input struct {
		StudentID string `json:"student_id"`
		Name      string `json:"name"`
		Password  string `json:"password"`
		Reason    string `json:"reason"`
	}
	if !bindJSON(c, &input) {
		return
	}
	item, err := s.Exam.AddContestant(c, "admin", input.StudentID, input.Name, input.Password, input.Reason)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (s Server) adminUpdateContestant(c *gin.Context) {
	var input struct {
		Name     string `json:"name"`
		Password string `json:"password"`
		Disabled *bool  `json:"disabled"`
		Finished *bool  `json:"finished"`
		Reason   string `json:"reason"`
	}
	if !bindJSON(c, &input) {
		return
	}
	item, err := s.Exam.UpdateContestant(c, "admin", number(c, "id"), exam.ContestantUpdate{
		Name: input.Name, Password: input.Password, Disabled: input.Disabled, Finished: input.Finished, Reason: input.Reason,
	})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (s Server) adminSubmissions(c *gin.Context) {
	items, err := s.Exam.ListSubmissions(c, exam.SubmissionFilter{
		StudentID: c.Query("student_id"),
		Label:     c.Query("label"),
		Language:  c.Query("language"),
		Limit:     2000,
	})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (s Server) adminSubmissionSource(c *gin.Context) {
	item, _, err := s.Exam.SubmissionSource(c, number(c, "id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (s Server) adminSchedule(c *gin.Context) {
	var input struct {
		ExamStartAt string `json:"exam_start_at"`
		ExamEndAt   string `json:"exam_end_at"`
	}
	if !bindJSON(c, &input) {
		return
	}
	exam, err := s.Exam.Schedule(c, "admin", input.ExamStartAt, input.ExamEndAt)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, exam)
}

func (s Server) adminExamAction(c *gin.Context) {
	var input struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&input)
	action := c.Param("action")
	if action == "abort" {
		updated, err := s.Exam.Abort(c, "admin", input.Reason)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, updated)
		return
	}
	// 懒推进到当前时间对应的状态，保证边界时刻的手动操作立即生效。
	if _, err := s.Exam.Exam(c); err != nil {
		fail(c, err)
		return
	}
	updated, err := s.Exam.SetState(c, "admin", action, input.Reason)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, updated)
}

func (s Server) adminRestart(c *gin.Context) {
	var input struct {
		ClearSubmissions bool   `json:"clear_submissions"`
		ExamStartAt      string `json:"exam_start_at"`
		ExamEndAt        string `json:"exam_end_at"`
	}
	if !bindJSON(c, &input) {
		return
	}
	examState, err := s.Exam.Restart(c, "admin", input.ClearSubmissions, input.ExamStartAt, input.ExamEndAt)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, examState)
}

func (s Server) adminImport(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		fail(c, errors.New("需要选择比赛包 ZIP"))
		return
	}
	input, err := file.Open()
	if err != nil {
		fail(c, err)
		return
	}
	defer input.Close()
	data, err := readLimited(input, 1<<30)
	if err != nil {
		fail(c, err)
		return
	}
	item, err := s.Exam.Import(c, "admin", data)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (s Server) adminExport(c *gin.Context) {
	result, data, err := s.Exam.Export(c, "admin")
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", result.FileName))
	c.Data(http.StatusOK, "application/zip", data)
}

func (s Server) adminAudit(c *gin.Context) {
	items, err := s.Exam.AuditLogs(c, 300)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (s Server) adminClearAudit(c *gin.Context) {
	if err := s.Exam.ClearAuditLogs(c, "admin"); err != nil {
		fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s Server) adminChangePassword(c *gin.Context) {
	var input struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if !bindJSON(c, &input) {
		return
	}
	if err := s.Exam.UpdateAdminPassword(c, "admin", input.OldPassword, input.NewPassword); err != nil {
		fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func readLimited(value io.Reader, maximum int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(value, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("上传文件过大")
	}
	return data, nil
}

package web

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
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
	if err := s.Exam.AuthenticateAdmin(c.Request.Context(), input.Username, input.Password); err != nil {
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
	examState, err := s.Exam.Exam(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	problems, err := s.Exam.ListProblems(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	contestants, err := s.Exam.ListContestants(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	submissionTotal, err := s.Exam.SubmissionCount(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	byProblem, err := s.Exam.CountsByProblem(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	recent, err := s.Exam.ListSubmissions(c.Request.Context(), exam.SubmissionFilter{Limit: 15})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"exam":                   examState,
		"server_time":            examTime(),
		"online":                 s.activity.count(5 * time.Minute),
		"problem_count":          len(problems),
		"contestant_count":       len(contestants),
		"submission_count":       submissionTotal,
		"submissions_by_problem": byProblem,
		"recent":                 recent,
	})
}

func (s Server) adminGetRules(c *gin.Context) {
	rules, err := s.Exam.Rules(c.Request.Context())
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
	rules, err := s.Exam.SetRules(c.Request.Context(), "admin", input.Rules)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (s Server) adminChecks(c *gin.Context) {
	checks, err := s.Exam.Checks(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, checks)
}

func (s Server) adminContestants(c *gin.Context) {
	if c.Query("page") != "" || c.Query("page_size") != "" {
		request, err := parsePageRequest(c)
		if err != nil {
			fail(c, err)
			return
		}
		page, err := s.Exam.ContestantsPage(c.Request.Context(), request, c.Query("query"), c.Query("status"))
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, page)
		return
	}
	items, err := s.Exam.ListContestants(c.Request.Context())
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
	}
	if !bindJSON(c, &input) {
		return
	}
	item, err := s.Exam.AddContestant(c.Request.Context(), "admin", input.StudentID, input.Name, input.Password)
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
	}
	if !bindJSON(c, &input) {
		return
	}
	item, err := s.Exam.UpdateContestant(c.Request.Context(), "admin", number(c, "id"), exam.ContestantUpdate{
		Name: input.Name, Password: input.Password, Disabled: input.Disabled, Finished: input.Finished,
	})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (s Server) adminSubmissions(c *gin.Context) {
	if c.Query("page") != "" || c.Query("page_size") != "" {
		request, err := parsePageRequest(c)
		if err != nil {
			fail(c, err)
			return
		}
		page, err := s.Exam.SubmissionsPage(c.Request.Context(), request, exam.SubmissionFilter{StudentID: c.Query("student_id"), Label: c.Query("label"), Language: c.Query("language")})
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, page)
		return
	}
	items, err := s.Exam.ListSubmissions(c.Request.Context(), exam.SubmissionFilter{
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
	item, _, err := s.Exam.SubmissionSource(c.Request.Context(), number(c, "id"))
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
	exam, err := s.Exam.Schedule(c.Request.Context(), "admin", input.ExamStartAt, input.ExamEndAt)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, exam)
}

func (s Server) adminExamAction(c *gin.Context) {
	action := c.Param("action")
	if action == "abort" {
		updated, err := s.Exam.Abort(c.Request.Context(), "admin")
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, updated)
		return
	}
	// 懒推进到当前时间对应的状态，保证边界时刻的手动操作立即生效。
	if _, err := s.Exam.Exam(c.Request.Context()); err != nil {
		fail(c, err)
		return
	}
	updated, err := s.Exam.SetState(c.Request.Context(), "admin", action)
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
	examState, err := s.Exam.Restart(c.Request.Context(), "admin", input.ClearSubmissions, input.ExamStartAt, input.ExamEndAt)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, examState)
}

func (s Server) adminImport(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		fail(c, errors.New("请选择 OJ 导出的考试包 ZIP"))
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
	if c.FullPath() == "/api/admin/import-preview" {
		preview, err := s.Exam.PreviewImport(data)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, preview)
		return
	}
	if c.PostForm("confirmed") != "true" {
		fail(c, errors.New("请先预览并确认替换当前考试"))
		return
	}
	item, err := s.Exam.Import(c.Request.Context(), "admin", data)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (s Server) adminExport(c *gin.Context) {
	result, data, err := s.Exam.Export(c.Request.Context(), "admin")
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": result.FileName}))
	c.Data(http.StatusOK, "application/zip", data)
}

func (s Server) adminAudit(c *gin.Context) {
	if c.Query("page") != "" || c.Query("page_size") != "" {
		request, err := parsePageRequest(c)
		if err != nil {
			fail(c, err)
			return
		}
		page, err := s.Exam.AuditPage(c.Request.Context(), request)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, page)
		return
	}
	items, err := s.Exam.AuditLogs(c.Request.Context(), 300)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (s Server) adminClearAudit(c *gin.Context) {
	if err := s.Exam.ClearAuditLogs(c.Request.Context(), "admin"); err != nil {
		fail(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s Server) adminChangePassword(c *gin.Context) {
	var input struct {
		NewPassword string `json:"new_password"`
	}
	if !bindJSON(c, &input) {
		return
	}
	if err := s.Exam.UpdateAdminPassword(c.Request.Context(), "admin", input.NewPassword); err != nil {
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

func parsePageRequest(c *gin.Context) (exam.PageRequest, error) {
	request := exam.PageRequest{Page: 1, PageSize: 20}
	for key, target := range map[string]*int{"page": &request.Page, "page_size": &request.PageSize} {
		if value := c.Query(key); value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 1 {
				return request, errors.New("分页参数必须是正整数")
			}
			*target = number
		}
	}
	return request, nil
}

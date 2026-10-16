package web

import (
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"

	"justcpc-exam-server/src/exam"
	"justcpc-exam-server/src/store"
)

type problemView struct {
	exam.Problem
	Status        string `json:"status"` // submitted / not_submitted
	LastLanguage  string `json:"last_language,omitempty"`
	LastSubmitted string `json:"last_submitted_at,omitempty"`
	SubmissionID  int64  `json:"last_submission_id,omitempty"`
}

func (s Server) studentLogin(c *gin.Context) {
	if !s.limiter.allow("login:"+clientIP(c), 20, time.Minute) {
		fail(c, errTooMany)
		return
	}
	var input struct {
		StudentID string `json:"student_id"`
		Password  string `json:"password"`
	}
	if !bindJSON(c, &input) {
		return
	}
	contestant, err := s.Exam.AuthenticateContestant(c, input.StudentID, input.Password)
	if err != nil {
		fail(c, err)
		return
	}
	s.Exam.MarkContestantIP(c, contestant.ID, clientIP(c))
	s.sessions.set(c.Writer, studentCookie, principal{Role: "student", ID: contestant.ID, ExamGeneration: contestant.ExamGeneration})
	c.JSON(http.StatusOK, contestant)
}

func (s Server) studentLogout(c *gin.Context) {
	s.sessions.clear(c.Writer, studentCookie)
	c.Status(http.StatusNoContent)
}

func (s Server) studentMe(c *gin.Context) {
	contestant, err := s.Exam.Contestant(c, s.user(c).ID)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, contestant)
}

func (s Server) studentExam(c *gin.Context) {
	examState, err := s.Exam.Exam(c)
	if err != nil {
		fail(c, err)
		return
	}
	rules, err := s.Exam.Rules(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"name":          examState.Name,
		"description":   examState.Description,
		"state":         examState.State,
		"started_at":    examState.StartedAt,
		"finished_at":   examState.FinishedAt,
		"exam_start_at": examState.ExamStartAt,
		"exam_end_at":   examState.ExamEndAt,
		"rules":         rules,
		"server_time":   examTime(),
	})
}

func (s Server) studentProblems(c *gin.Context) {
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
	last, err := s.Exam.LastByProblem(c, s.user(c).ID)
	if err != nil {
		fail(c, err)
		return
	}
	views := make([]problemView, 0, len(problems))
	visible := examState.State == exam.StateRunning || examState.State == exam.StatePaused
	for _, item := range problems {
		view := problemView{Problem: item, Status: "not_submitted"}
		if submission, ok := last[item.Label]; ok {
			view.Status = "submitted"
			view.LastLanguage = submission.Language
			view.LastSubmitted = submission.SubmittedAt
			view.SubmissionID = submission.ID
		}
		views = append(views, view)
	}
	if !visible {
		views = []problemView{}
	}
	sort.Slice(views, func(i, j int) bool { return views[i].OrderIndex < views[j].OrderIndex })
	c.JSON(http.StatusOK, gin.H{"state": examState.State, "open": examState.State == exam.StateRunning, "problems": views})
}

func (s Server) studentStatement(c *gin.Context) {
	if !s.limiter.allow("statement:"+clientIP(c), 1, 20*time.Second) {
		fail(c, errTooMany)
		return
	}
	examState, err := s.Exam.Exam(c)
	if err != nil {
		fail(c, err)
		return
	}
	if examState.StatementPDFPath == "" {
		fail(c, errNoStatement)
		return
	}
	// 题面统一以加密压缩包发放（无论是否已开考），密码在开考时由监考员公布。
	data, err := s.Exam.EncryptedStatement(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Content-Disposition", `attachment; filename="statement.zip"`)
	c.Data(http.StatusOK, "application/zip", data)
}

func (s Server) studentLast(c *gin.Context) {
	label := c.Param("label")
	problem, err := s.Exam.ProblemByLabel(c, label)
	if err != nil {
		fail(c, err)
		return
	}
	last, err := s.Exam.LastByProblem(c, s.user(c).ID)
	if err != nil {
		fail(c, err)
		return
	}
	submission, ok := last[problem.Label]
	if !ok {
		c.JSON(http.StatusOK, gin.H{"submitted": false})
		return
	}
	_, source, err := s.Exam.SubmissionSource(c, submission.ID)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"submitted": true, "submission_id": submission.ID,
		"language": submission.Language, "submitted_at": submission.SubmittedAt, "source": source,
	})
}

func (s Server) studentSubmit(c *gin.Context) {
	if !s.limiter.allow("submit:"+clientIP(c), 30, time.Minute) {
		fail(c, errTooMany)
		return
	}
	var input struct {
		Language string `json:"language"`
		Source   string `json:"source"`
	}
	if !bindJSON(c, &input) {
		return
	}
	submission, err := s.Exam.Submit(c, s.user(c).ID, c.Param("label"), input.Language, input.Source)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, submission)
}

func (s Server) studentSubmissions(c *gin.Context) {
	items, err := s.Exam.ListByContestant(c, s.user(c).ID)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (s Server) studentEarlySubmit(c *gin.Context) {
	var input struct {
		Confirm bool   `json:"confirm"`
		Reason  string `json:"reason"`
	}
	if !bindJSON(c, &input) {
		return
	}
	if !input.Confirm {
		fail(c, errConfirmRequired)
		return
	}
	contestant, err := s.Exam.EarlySubmit(c, s.user(c).ID, input.Reason)
	if err != nil {
		fail(c, err)
		return
	}
	s.sessions.clear(c.Writer, studentCookie)
	c.JSON(http.StatusOK, contestant)
}

var (
	errTooMany         = &apiError{"操作过于频繁，请稍后再试"}
	errNoStatement     = &apiError{"比赛题面缺失"}
	errConfirmRequired = &apiError{"需要确认后才能交卷"}
)

type apiError struct{ message string }

func (e *apiError) Error() string { return e.message }

func examTime() string { return store.Now() }

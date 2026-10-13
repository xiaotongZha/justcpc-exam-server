package exam

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
)

type Check struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Checks 执行启动前检查，返回各项结果。未通过时前端应阻止开始考试。
func (s Service) Checks(ctx context.Context) ([]Check, error) {
	checks := make([]Check, 0, 10)
	add := func(name string, ok bool, message string) {
		checks = append(checks, Check{Name: name, OK: ok, Message: message})
	}

	exam, err := s.Exam(ctx)
	if err != nil {
		return nil, err
	}
	add("比赛包", exam.Name != "", choose(exam.Name != "", exam.Name, "尚未导入比赛包"))

	problems, err := s.ListProblems(ctx)
	if err != nil {
		return nil, err
	}
	add("题目配置", len(problems) > 0, fmt.Sprintf("%d 道题", len(problems)))

	if exam.StatementPDFPath != "" {
		if _, err := os.Stat(s.Store.Absolute(exam.StatementPDFPath)); err == nil {
			add("比赛题面", true, "statement.pdf 就绪")
		} else {
			add("比赛题面", false, "statement.pdf 缺失")
		}
	} else {
		add("比赛题面", false, "尚未导入题面")
	}

	contestants, err := s.ListContestants(ctx)
	if err != nil {
		return nil, err
	}
	add("考生名单", len(contestants) > 0, fmt.Sprintf("%d 名考生", len(contestants)))

	referenceOK := len(problems) > 0
	referenceMessage := "全部题目引用有效"
	for _, item := range problems {
		if item.OJProblemID <= 0 {
			referenceOK, referenceMessage = false, fmt.Sprintf("题目 %s 缺少平台题目 ID", item.Label)
			break
		}
	}
	add("题目引用", referenceOK, referenceMessage)

	add("数据目录", writable(s.Store.DataRoot), s.Store.DataRoot)

	addresses := localAddresses()
	add("本机地址", len(addresses) > 0, choose(len(addresses) > 0, strings.Join(addresses, "、"), "未检测到局域网地址"))

	return checks, nil
}

func choose(ok bool, whenTrue, whenFalse string) string {
	if ok {
		return whenTrue
	}
	return whenFalse
}

func writable(dir string) bool {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return false
	}
	file, err := os.CreateTemp(dir, ".check-*")
	if err != nil {
		return false
	}
	name := file.Name()
	file.Close()
	_ = os.Remove(name)
	return true
}

func localAddresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var result []string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip != nil {
				result = append(result, ip.String())
			}
		}
	}
	return result
}

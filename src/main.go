package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"justcpc-exam-server/src/exam"
	"justcpc-exam-server/src/store"
	"justcpc-exam-server/src/web"
)

type startupInfo struct {
	AdminURL          string
	StudentURLs       []string
	InitialLogin      string
	StatementPassword string
}

func main() {
	console := flag.Bool("console", false, "使用命令行模式运行")
	configPath := flag.String("config", "", "指定配置文件路径")
	flag.Parse()
	if *configPath == "" {
		*configPath = os.Getenv("JUSTCPC_EXAM_CONFIG")
	}
	if *configPath == "" {
		*configPath = platformConfigPath()
	}
	absolute, err := filepath.Abs(*configPath)
	if err != nil {
		platformError(err)
		return
	}
	platformLaunch(absolute, *console, func(ctx context.Context, ready func(startupInfo)) error {
		return runServer(ctx, absolute, ready)
	})
}

func runServer(ctx context.Context, configPath string, ready func(startupInfo)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg, err := loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("读取配置 %s：%w", configPath, err)
	}
	if len(cfg.SessionSecret) < 32 {
		return fmt.Errorf("session_secret 至少需要 32 字节，请检查 %s", configPath)
	}
	if !filepath.IsAbs(cfg.Data) {
		cfg.Data = filepath.Join(filepath.Dir(configPath), cfg.Data)
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("无法监听 %s，端口可能已被其他程序占用：%w", cfg.Listen, err)
	}
	defer listener.Close()

	storage, err := store.Open(filepath.Join(cfg.Data, "exam.sqlite"), cfg.Data)
	if err != nil {
		return err
	}
	defer storage.Close()
	if err := storage.EnsureLayout(); err != nil {
		return err
	}
	service := exam.Service{Store: storage, StatementPassword: cfg.StatementPassword}
	var admins int
	if err := storage.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin`).Scan(&admins); err != nil {
		return err
	}
	if err := service.EnsureAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		return err
	}
	server, err := web.NewServer(service, cfg.Listen, cfg.SessionSecret)
	if err != nil {
		return err
	}
	gin.DefaultWriter = log.Writer()
	gin.DefaultErrorWriter = log.Writer()
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second}
	serveDone := make(chan error, 1)
	go func() { serveDone <- httpServer.Serve(listener) }()
	defer func() {
		server.CloseEvents()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelShutdown()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
			_ = httpServer.Close()
		}
	}()

	info := serverAddresses(listener.Addr().String())
	info.StatementPassword = service.StatementPasswordOr()
	// 只有本机健康检查成功后才显示运行中、打开管理页。
	probeCtx, stopProbe := context.WithTimeout(ctx, 3*time.Second)
	defer stopProbe()
	request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, strings.TrimSuffix(info.AdminURL, "/admin")+"/api/health", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 3 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("本机启动检查失败：%w", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("本机启动检查失败：HTTP %d", response.StatusCode)
	}
	if admins == 0 {
		info.InitialLogin = fmt.Sprintf("初始管理员：%s / %s（登录后请修改密码）", cfg.AdminUsername, cfg.AdminPassword)
	}
	log.Printf("JustCPC Exam Server 已启动：%s", listener.Addr())
	log.Printf("管理员入口 %s；考生入口 %s", info.AdminURL, strings.Join(info.StudentURLs, "  "))
	if info.InitialLogin != "" {
		log.Print(info.InitialLogin)
	}
	log.Printf("试题解压密码：%s", info.StatementPassword)
	log.Print("修改端口、初始管理员密码或解压密码：先停止服务，修改 config.json，再重新启动。")
	log.Print("初始管理员密码仅首次创建账号时生效；已有账号请在管理页面「系统设置」中修改。")
	ready(info)
	go server.Exam.RunAutoAdvance(ctx, time.Second)
	if checks, err := service.Checks(ctx); err == nil {
		for _, check := range checks {
			log.Printf("[check %t] %s: %s", check.OK, check.Name, check.Message)
		}
	}
	select {
	case <-ctx.Done():
		log.Print("正在停止考试服务…")
		return nil
	case err := <-serveDone:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("考试服务停止：%w", err)
	}
}

func serverAddresses(listen string) startupInfo {
	host, port, _ := net.SplitHostPort(listen)
	localHost := host
	if host == "" || host == "0.0.0.0" {
		localHost = "127.0.0.1"
	}
	if host == "::" {
		localHost = "::1"
	}
	info := startupInfo{AdminURL: "http://" + net.JoinHostPort(localHost, port) + "/admin"}
	if host == "" || host == "0.0.0.0" || host == "::" {
		interfaces, _ := net.Interfaces()
		seen := map[string]bool{}
		for _, iface := range interfaces {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addresses, _ := iface.Addrs()
			for _, address := range addresses {
				ip, _, err := net.ParseCIDR(address.String())
				if err != nil || ip.To4() == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
					continue
				}
				url := "http://" + net.JoinHostPort(ip.String(), port) + "/"
				if !seen[url] {
					info.StudentURLs = append(info.StudentURLs, url)
					seen[url] = true
				}
			}
		}
		sort.Strings(info.StudentURLs)
	}
	if len(info.StudentURLs) == 0 {
		info.StudentURLs = []string{"http://" + net.JoinHostPort(localHost, port) + "/"}
	}
	return info
}

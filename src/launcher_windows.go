//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	kernel32            = windows.NewLazySystemDLL("kernel32.dll")
	gdi32               = windows.NewLazySystemDLL("gdi32.dll")
	createWindow        = user32.NewProc("CreateWindowExW")
	defWindowProc       = user32.NewProc("DefWindowProcW")
	sendMessage         = user32.NewProc("SendMessageW")
	postMessage         = user32.NewProc("PostMessageW")
	showWindow          = user32.NewProc("ShowWindow")
	setForegroundWindow = user32.NewProc("SetForegroundWindow")
	enableWindow        = user32.NewProc("EnableWindow")
	setWindowText       = user32.NewProc("SetWindowTextW")
	messageBox          = user32.NewProc("MessageBoxW")
)

const (
	wmUpdate           = 0x8001
	wmActivateInstance = 0x8002
	buttonAdmin        = 101
	buttonCopy         = 102
	buttonLogs         = 103
	buttonStop         = 104
)

func wide(value string) *uint16 { return windows.StringToUTF16Ptr(value) }

func platformConfigPath() string {
	executable, err := os.Executable()
	if err != nil {
		return "config.json"
	}
	if strings.Contains(filepath.ToSlash(executable), "/go-build") {
		return "config.json"
	}
	return filepath.Join(filepath.Dir(executable), "config.json")
}

func platformError(err error) {
	log.Print(err)
	messageBox.Call(0, uintptr(unsafe.Pointer(wide(err.Error()))), uintptr(unsafe.Pointer(wide("JustCPC 考试服务"))), 0x10)
}

func platformLaunch(configPath string, console bool, run func(context.Context, func(startupInfo)) error) {
	// 名称以配置文件区分；重复打开同一部署只激活已有窗口。
	identityPath := configPath
	if resolved, err := filepath.EvalSymlinks(configPath); err == nil {
		identityPath = resolved
	}
	identity := fmt.Sprintf("%x", sha256.Sum256([]byte(strings.ToLower(filepath.Clean(identityPath)))))[:24]
	className := "JustCPCExamLauncher-" + identity
	mutex, err := windows.CreateMutex(nil, false, wide(`Local\JustCPCExam-`+identity))
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if mutex != 0 {
			defer windows.CloseHandle(mutex)
		}
		// 第一实例可能尚在创建窗口，短暂等待；不读取配置、不触碰数据库。
		for attempt := 0; attempt < 40; attempt++ {
			hwnd, _, _ := user32.NewProc("FindWindowW").Call(uintptr(unsafe.Pointer(wide(className))), 0)
			if hwnd != 0 {
				showWindow.Call(hwnd, 9)
				setForegroundWindow.Call(hwnd)
				postMessage.Call(hwnd, wmActivateInstance, 0, 0)
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		messageBox.Call(0, uintptr(unsafe.Pointer(wide("考试服务已经启动（可能使用命令行模式），请打开已有窗口或查看日志，勿重复启动。"))), uintptr(unsafe.Pointer(wide("JustCPC 考试服务"))), 0x40)
		return
	}
	if err != nil {
		platformError(fmt.Errorf("无法建立单实例保护：%w", err))
		return
	}
	defer windows.CloseHandle(mutex)

	logPath := filepath.Join(filepath.Dir(configPath), "exam-server.log")
	if stat, err := os.Stat(logPath); err == nil && stat.Size() > 2<<20 {
		_ = os.Remove(logPath + ".previous")
		_ = os.Rename(logPath, logPath+".previous")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		platformError(fmt.Errorf("无法写入日志，请将整个发行目录放到可写位置：%w", err))
		return
	}
	defer logFile.Close()
	if console {
		kernel32.NewProc("AttachConsole").Call(^uintptr(0))
		if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			defer out.Close()
			log.SetOutput(io.MultiWriter(logFile, out))
		} else {
			log.SetOutput(logFile)
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
		defer cancel()
		if err := run(ctx, func(startupInfo) {}); err != nil {
			log.Print(err)
			os.Exit(1)
		}
		return
	}
	log.SetOutput(logFile)
	if err := runLauncher(className, logPath, run); err != nil {
		platformError(err)
	}
}

type windowClass struct {
	Size, Style                        uint32
	Procedure                          uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	MenuName, ClassName                *uint16
	SmallIcon                          uintptr
}

type windowMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	X, Y           int32
	Private        uint32
}

type launcherState struct {
	sync.Mutex
	info   startupInfo
	status string
	ready  bool
	done   bool
}

func runLauncher(className, logPath string, run func(context.Context, func(startupInfo)) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if proc := user32.NewProc("SetProcessDPIAware"); proc.Find() == nil {
		proc.Call()
	}
	dpi := uintptr(96)
	if proc := user32.NewProc("GetDpiForSystem"); proc.Find() == nil {
		if value, _, _ := proc.Call(); value != 0 {
			dpi = value
		}
	}
	scale := func(value int) uintptr { return uintptr(value) * dpi / 96 }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := &launcherState{status: "正在启动，请稍候…"}
	var hwnd, statusControl, addressesControl, credentialsControl, statementPasswordControl, adminControl, copyControl, stopControl uintptr
	var stopping bool
	open := func(target string) {
		if target == "" {
			return
		}
		if err := windows.ShellExecute(windows.Handle(hwnd), wide("open"), wide(target), nil, nil, 1); err != nil {
			platformError(fmt.Errorf("无法打开 %s：%w", target, err))
		}
	}
	requestStop := func() {
		if stopping {
			return
		}
		state.Lock()
		done := state.done
		state.Unlock()
		if done {
			user32.NewProc("DestroyWindow").Call(hwnd)
			return
		}
		answer, _, _ := messageBox.Call(hwnd, uintptr(unsafe.Pointer(wide("停止服务后学生将无法连接或提交代码。确定停止并退出？"))), uintptr(unsafe.Pointer(wide("停止考试服务"))), 0x24)
		if answer != 6 {
			return
		}
		stopping = true
		setWindowText.Call(statusControl, uintptr(unsafe.Pointer(wide("正在停止服务，请稍候…"))))
		enableWindow.Call(stopControl, 0)
		enableWindow.Call(adminControl, 0)
		enableWindow.Call(copyControl, 0)
		cancel()
	}
	procedure := syscall.NewCallback(func(window uintptr, message uint32, wparam, lparam uintptr) uintptr {
		switch message {
		case 0x10:
			requestStop()
			return 0 // WM_CLOSE
		case 0x2:
			user32.NewProc("PostQuitMessage").Call(0)
			return 0
		case wmActivateInstance:
			showWindow.Call(window, 9)
			setForegroundWindow.Call(window)
			return 0
		case wmUpdate:
			state.Lock()
			status, info, ready, done := state.status, state.info, state.ready, state.done
			state.Unlock()
			if done && stopping {
				user32.NewProc("DestroyWindow").Call(window)
				return 0
			}
			setWindowText.Call(statusControl, uintptr(unsafe.Pointer(wide(status))))
			setWindowText.Call(addressesControl, uintptr(unsafe.Pointer(wide(strings.Join(info.StudentURLs, "\r\n")))))
			setWindowText.Call(credentialsControl, uintptr(unsafe.Pointer(wide(info.InitialLogin))))
			setWindowText.Call(statementPasswordControl, uintptr(unsafe.Pointer(wide(info.StatementPassword))))
			var enabled uintptr
			if ready && !done && !stopping {
				enabled = 1
			}
			enableWindow.Call(adminControl, enabled)
			enableWindow.Call(copyControl, enabled)
			if done {
				setWindowText.Call(stopControl, uintptr(unsafe.Pointer(wide("退出窗口"))))
			}
			return 0
		case 0x111: // WM_COMMAND
			switch int(wparam & 0xffff) {
			case buttonAdmin:
				state.Lock()
				url := state.info.AdminURL
				state.Unlock()
				open(url)
			case buttonCopy:
				state.Lock()
				text := strings.Join(state.info.StudentURLs, "\r\n")
				state.Unlock()
				if err := copyClipboard(window, text); err != nil {
					platformError(err)
				} else {
					setWindowText.Call(copyControl, uintptr(unsafe.Pointer(wide("地址已复制"))))
				}
			case buttonLogs:
				open(logPath)
			case buttonStop:
				requestStop()
			}
			return 0
		}
		result, _, _ := defWindowProc.Call(window, uintptr(message), wparam, lparam)
		return result
	})
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	cursor, _, _ := user32.NewProc("LoadCursorW").Call(0, 32512)
	class := windowClass{Procedure: procedure, Instance: instance, Cursor: cursor, Background: 16, ClassName: wide(className)}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return fmt.Errorf("创建启动窗口失败：%w", err)
	}
	defer user32.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(class.ClassName)), instance)
	window, _, err := createWindow.Call(0, uintptr(unsafe.Pointer(class.ClassName)), uintptr(unsafe.Pointer(wide("JustCPC · 考场考试服务"))), 0x00ca0000, 0x80000000, 0x80000000, scale(760), scale(650), 0, 0, instance, 0)
	if window == 0 {
		return fmt.Errorf("创建启动窗口失败：%w", err)
	}
	hwnd = window
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	font, _, _ := gdi32.NewProc("CreateFontW").Call(uintptr(-int64(scale(16))), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(wide("Microsoft YaHei UI"))))
	defer gdi32.NewProc("DeleteObject").Call(font)
	control := func(kind, text string, style uintptr, x, y, w, h int, id int) uintptr {
		child, _, _ := createWindow.Call(0, uintptr(unsafe.Pointer(wide(kind))), uintptr(unsafe.Pointer(wide(text))), 0x50000000|style, scale(x), scale(y), scale(w), scale(h), hwnd, uintptr(id), instance, 0)
		sendMessage.Call(child, 0x30, font, 1)
		return child
	}
	control("STATIC", "JustCPC 考场考试服务", 0, 24, 22, 700, 28, 0)
	statusControl = control("EDIT", state.status, 0x0804, 24, 64, 694, 72, 0)
	control("STATIC", "学生访问地址（将以下局域网地址提供给考生）", 0, 24, 150, 694, 24, 0)
	addressesControl = control("EDIT", "启动成功后显示地址", 0x00a00844, 24, 182, 694, 84, 0)
	credentialsControl = control("EDIT", "", 0x0804, 24, 280, 694, 48, 0)
	control("STATIC", "试题解压密码", 0, 24, 340, 130, 28, 0)
	statementPasswordControl = control("EDIT", "服务启动后显示", 0x0880, 160, 340, 558, 28, 0)
	adminControl = control("BUTTON", "打开管理页面", 0x10000, 24, 394, 160, 38, buttonAdmin)
	copyControl = control("BUTTON", "复制学生地址", 0x10000, 196, 394, 160, 38, buttonCopy)
	control("BUTTON", "查看运行日志", 0x10000, 368, 394, 160, 38, buttonLogs)
	stopControl = control("BUTTON", "停止并退出", 0x10000, 540, 394, 178, 38, buttonStop)
	control("STATIC", "修改端口、初始管理员密码或解压密码：先停止服务，修改 config.json，再重新启动。\r\n初始管理员密码仅首次创建生效；已有账号请在管理页面「系统设置」中修改。\r\n保持本窗口运行；最小化不影响考试。考生无法访问时，请检查防火墙和考场网络。", 0, 24, 456, 694, 144, 0)
	enableWindow.Call(adminControl, 0)
	enableWindow.Call(copyControl, 0)
	showWindow.Call(hwnd, 1)
	user32.NewProc("UpdateWindow").Call(hwnd)
	runFinished := make(chan struct{})
	defer func() {
		cancel()
		select {
		case <-runFinished:
		case <-time.After(7 * time.Second):
		}
	}()
	go func() {
		defer close(runFinished)
		err := run(ctx, func(info startupInfo) {
			state.Lock()
			state.info = info
			state.status = "服务运行中。请打开管理页面导入考试包、设定考试时间。"
			state.ready = true
			state.Unlock()
			postMessage.Call(hwnd, wmUpdate, 0, 0)
		})
		state.Lock()
		state.done = true
		if err != nil {
			state.status = "启动或运行失败：" + err.Error() + "\r\n请查看运行日志。"
			log.Print(err)
		} else {
			state.status = "服务已停止。"
		}
		state.Unlock()
		postMessage.Call(hwnd, wmUpdate, 0, 0)
	}()
	var message windowMessage
	for {
		result, _, err := user32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) == -1 {
			return fmt.Errorf("启动窗口消息错误：%w", err)
		}
		if result == 0 {
			break
		}
		if handled, _, _ := user32.NewProc("IsDialogMessageW").Call(hwnd, uintptr(unsafe.Pointer(&message))); handled != 0 {
			continue
		}
		user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&message)))
		user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&message)))
	}
	return nil
}

func copyClipboard(window uintptr, text string) error {
	ok, _, err := user32.NewProc("OpenClipboard").Call(window)
	if ok == 0 {
		return fmt.Errorf("无法打开剪贴板：%w", err)
	}
	defer user32.NewProc("CloseClipboard").Call()
	value := windows.StringToUTF16(text)
	handle, _, err := kernel32.NewProc("GlobalAlloc").Call(0x42, uintptr(len(value)*2))
	if handle == 0 {
		return err
	}
	transferred := false
	defer func() {
		if !transferred {
			kernel32.NewProc("GlobalFree").Call(handle)
		}
	}()
	address, _, err := kernel32.NewProc("GlobalLock").Call(handle)
	if address == 0 {
		return err
	}
	kernel32.NewProc("RtlMoveMemory").Call(address, uintptr(unsafe.Pointer(&value[0])), uintptr(len(value)*2))
	runtime.KeepAlive(value)
	kernel32.NewProc("GlobalUnlock").Call(handle)
	user32.NewProc("EmptyClipboard").Call()
	if result, _, err := user32.NewProc("SetClipboardData").Call(13, handle); result == 0 {
		return err
	}
	transferred = true // 成功后内存归系统所有。
	return nil
}

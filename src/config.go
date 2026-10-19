package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// config 汇集启动配置，全部由 config.json 提供。密文字段可由同名环境变量补充。
type config struct {
	Data              string `json:"data"`
	Listen            string `json:"listen"`
	AdminUsername     string `json:"admin_username"`
	AdminPassword     string `json:"admin_password"`
	SessionSecret     string `json:"session_secret"`
	StatementPassword string `json:"statement_password"`
}

func defaultConfig() config {
	return config{
		Data:              "./data",
		Listen:            "0.0.0.0:10293",
		AdminUsername:     "admin",
		StatementPassword: "GoJustCPC",
	}
}

// loadConfig 读取配置；文件不存在时自动生成一份（随机密钥与初始管理员密码）。
func loadConfig(path string) (config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return generateConfig(path)
		}
		return defaultConfig(), err
	}
	cfg := defaultConfig()
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Data == "" {
		cfg.Data = defaultConfig().Data
	}
	if cfg.Listen == "" {
		cfg.Listen = defaultConfig().Listen
	}
	if cfg.AdminUsername == "" {
		cfg.AdminUsername = "admin"
	}
	if cfg.StatementPassword == "" {
		cfg.StatementPassword = "GoJustCPC"
	}
	// Release packages include an editable config before the first launch.
	// Complete only blank credentials; environment-provided values stay in the environment.
	effective := applyEnv(cfg)
	changed := false
	if effective.SessionSecret == "" {
		cfg.SessionSecret = randomToken(48)
		changed = true
	}
	if effective.AdminPassword == "" {
		cfg.AdminPassword = randomPassword(12)
		changed = true
	}
	if changed {
		if err := writeConfig(path, cfg); err != nil {
			return cfg, fmt.Errorf("补全配置文件失败（目录不可写？）：%w", err)
		}
	}
	return applyEnv(cfg), nil
}

// generateConfig 在配置文件缺失时生成随机密钥与初始管理员密码并写盘，
// 使发行包解压后无需任何手工配置即可启动。
func generateConfig(path string) (config, error) {
	cfg := defaultConfig()
	cfg.SessionSecret = randomToken(48)
	cfg.AdminPassword = randomPassword(12)
	if err := writeConfig(path, cfg); err != nil {
		return cfg, fmt.Errorf("生成配置文件失败（目录不可写？）：%w", err)
	}
	log.Printf("已生成配置文件 %s", path)
	return cfg, nil
}

func writeConfig(path string, cfg config) error {
	encoded, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func applyEnv(cfg config) config {
	if cfg.SessionSecret == "" {
		cfg.SessionSecret = os.Getenv("JUSTCPC_EXAM_SESSION_SECRET")
	}
	if cfg.AdminPassword == "" {
		cfg.AdminPassword = os.Getenv("JUSTCPC_EXAM_ADMIN_PASSWORD")
	}
	return cfg
}

// randomToken 生成 URL-safe base64 随机串（约 4/3*size 字节长）。
func randomToken(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// randomPassword 生成指定长度的字母数字随机密码。
func randomPassword(length int) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	buffer := make([]byte, length)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	out := make([]byte, length)
	for i, b := range buffer {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}

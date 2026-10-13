package exam

import (
	"bytes"
	"context"
	"errors"
	"os"

	yzip "github.com/yeka/zip"
)

// StatementPasswordOr 返回配置的题面压缩包密码，未配置时回退到默认值。
func (s Service) StatementPasswordOr() string {
	if s.StatementPassword == "" {
		return "GoJustCPC"
	}
	return s.StatementPassword
}

// EncryptedStatement 返回包含完整题面 PDF 的加密压缩包（AES-256，密码来自配置）。
// 题面统一以加密压缩包形式发放，学生在开考时用监考员公布的密码解压。
func (s Service) EncryptedStatement(ctx context.Context) ([]byte, error) {
	examState, err := s.Exam(ctx)
	if err != nil {
		return nil, err
	}
	if examState.StatementPDFPath == "" {
		return nil, errors.New("比赛题面缺失")
	}
	data, err := os.ReadFile(s.Store.Absolute(examState.StatementPDFPath))
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	writer := yzip.NewWriter(&buffer)
	file, err := writer.Encrypt("statement.pdf", s.StatementPasswordOr(), yzip.AES256Encryption)
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

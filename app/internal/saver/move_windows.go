package saver

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func moveExclusive(from, to string) error {
	src, err := windowsMovePath(from)
	if err != nil {
		return err
	}
	dst, err := windowsMovePath(to)
	if err != nil {
		return err
	}
	srcPtr, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	dstPtr, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	return windows.MoveFile(srcPtr, dstPtr)
}

func windowsMovePath(path string) (string, error) {
	path = filepath.FromSlash(path)
	if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) || strings.HasPrefix(path, `\??\`) {
		return path, nil
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Match the conservative threshold used by Go's Windows file operations.
	if len(path) < 248 {
		return path, nil
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:], nil
	}
	return `\\?\` + path, nil
}

package saver

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLinuxPublishFallsBackWhenExclusiveRenameIsUnsupported(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "temp")
	to := filepath.Join(dir, "output")
	if err := os.WriteFile(from, []byte("encoded crop"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Linux NFS rejects nonzero rename flags with EINVAL.
	unsupported := func(string, string) error { return unix.EINVAL }
	if err := publishLinux(from, to, unsupported); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(from+"-second", []byte("second crop"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := publishLinux(from+"-second", to, unsupported); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("collision error = %v, want ErrExist", err)
	}
	got, err := os.ReadFile(to)
	if err != nil || string(got) != "encoded crop" {
		t.Fatalf("output = %q, error: %v", got, err)
	}
}

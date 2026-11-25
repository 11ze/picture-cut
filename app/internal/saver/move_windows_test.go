package saver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"picturecut/internal/naming"
)

func TestWindowsMovePathSupportsExtendedDriveAndUNCPaths(t *testing.T) {
	suffix := strings.Repeat("folder\\", 40) + "crop.jpg"
	for _, tc := range []struct{ path, want string }{
		{`C:\` + suffix, `\\?\C:\` + suffix},
		{`\\host\share\` + suffix, `\\?\UNC\host\share\` + suffix},
		{`\\?\C:\` + suffix, `\\?\C:\` + suffix},
	} {
		got, err := windowsMovePath(tc.path)
		if err != nil || got != tc.want {
			t.Errorf("path %q = %q, want %q; error: %v", tc.path, got, tc.want, err)
		}
	}
}

func TestWindowsSaveToLongPath(t *testing.T) {
	source := writeSource(t)
	dir := t.TempDir()
	for len(dir) < 280 {
		dir = filepath.Join(dir, "picturecut-test-directory")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "crop.jpg")
	got, err := Save(context.Background(), Request{Source: source, Output: output, Format: naming.JPEG}, naming.High, nil)
	if err != nil || got != output {
		t.Fatalf("saved %q, want %q; error: %v", got, output, err)
	}
	if stat, err := os.Stat(output); err != nil || stat.Size() == 0 {
		t.Fatalf("output = %v, error: %v", stat, err)
	}
}

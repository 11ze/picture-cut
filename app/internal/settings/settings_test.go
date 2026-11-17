package settings

import (
	"os"
	"path/filepath"
	"testing"

	"picturecut/internal/naming"
)

func TestLoadFallsBackWhenMissingOrBroken(t *testing.T) {
	fallback := Settings{InPlace: true, OutDir: "/home/x/Desktop/裁剪输出", Quality: naming.Compressed}
	dir := t.TempDir()

	got := Load(filepath.Join(dir, "settings.json"), fallback)
	if got != fallback {
		t.Errorf("Load(missing) = %+v, want %+v", got, fallback)
	}

	broken := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(broken, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Load(broken, fallback); got != fallback {
		t.Errorf("Load(broken) = %+v, want %+v", got, fallback)
	}
}

func TestSaveThenLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	want := Settings{InPlace: false, OutDir: "/tmp/out", Quality: naming.High}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	if got := Load(path, Settings{}); got != want {
		t.Errorf("Load() = %+v, want %+v", got, want)
	}
}

func TestSaveReplacesTheFileWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	first := Settings{InPlace: false, OutDir: "/tmp/a", Quality: "high"}
	second := Settings{InPlace: true, OutDir: "/tmp/b", Quality: "compressed"}
	for _, s := range []Settings{first, second} {
		if err := Save(path, s); err != nil {
			t.Fatal(err)
		}
	}
	got := Load(path, Settings{})
	if got != second {
		t.Fatalf("settings = %+v, want %+v", got, second)
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatalf("left %d files next to settings", len(entries))
	}
}

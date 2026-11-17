package naming

import (
	"os"
	"path/filepath"
	"testing"
)

// Name follows the design's pattern: city_16x9_q80_20261117-103842.jpg.
func TestName(t *testing.T) {
	const stamp = "20261117-103842"
	cases := []struct {
		name    string
		stem    string
		ext     string
		ratio   string
		format  Format
		quality Quality
		want    string
	}{
		{"jpeg standard", "city", ".jpg", "16:9", JPEG, Compressed, "city_16x9_q80_20261117-103842.jpg"},
		{"jpeg high", "city", ".jpg", "16:9", JPEG, High, "city_16x9_20261117-103842.jpg"},
		{"png standard", "coffee", ".png", "16:9", PNG, Compressed, "coffee_16x9_compressed_20261117-103842.png"},
		{"png high", "coffee", ".png", "16:9", PNG, High, "coffee_16x9_20261117-103842.png"},
		{"decimal ratio", "phone", ".png", "9:19.5", PNG, High, "phone_9x19.5_20261117-103842.png"},
		{"extension case is kept", "portrait", ".JPEG", "1:1", JPEG, Compressed, "portrait_1x1_q80_20261117-103842.JPEG"},
		{"dots in the stem", "a.b", ".jpg", "4:3", JPEG, High, "a.b_4x3_20261117-103842.jpg"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Name(c.stem, c.ext, c.ratio, c.format, c.quality, stamp)
			if got != c.want {
				t.Errorf("Name() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestUnique(t *testing.T) {
	dir := t.TempDir()
	name := "city_16x9_q80_20261117-103842.jpg"

	if got, err := Unique(dir, name); err != nil || got != name {
		t.Fatalf("Unique() = %q, %v; want the name itself", got, err)
	}
	for _, existing := range []string{name} {
		if err := os.WriteFile(filepath.Join(dir, existing), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := Unique(dir, name); err != nil || got != "city_16x9_q80_20261117-103842-2.jpg" {
		t.Fatalf("Unique() = %q, %v; want -2", got, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "city_16x9_q80_20261117-103842-2.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := Unique(dir, name); err != nil || got != "city_16x9_q80_20261117-103842-3.jpg" {
		t.Fatalf("Unique() = %q, %v; want -3", got, err)
	}
}

func TestSplit(t *testing.T) {
	cases := []struct{ file, stem, ext string }{
		{"city.jpg", "city", ".jpg"},
		{"portrait.JPEG", "portrait", ".JPEG"},
		{"a.b.png", "a.b", ".png"},
		{"noext", "noext", ""},
	}
	for _, c := range cases {
		stem, ext := Split(c.file)
		if stem != c.stem || ext != c.ext {
			t.Errorf("Split(%q) = %q, %q; want %q, %q", c.file, stem, ext, c.stem, c.ext)
		}
	}
}

func TestReserveAvoidsDiskAndBatch(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := Reserve(dir, "a.jpg", nil); err != nil || got != "a-2.jpg" {
		t.Fatalf("Reserve on disk = %q, %v", got, err)
	}

	taken := map[string]bool{}
	if got, err := Reserve(dir, "b.jpg", taken); err != nil || got != "b.jpg" {
		t.Fatalf("first = %q, %v", got, err)
	}
	if got, err := Reserve(dir, "b.jpg", taken); err != nil || got != "b-2.jpg" {
		t.Fatalf("second = %q, %v", got, err)
	}
	if !taken["b-2.jpg"] || !taken["b.jpg"] {
		t.Fatalf("reserved names = %v", taken)
	}
	if got, err := Reserve(dir, "a.jpg", taken); err != nil || got != "a-2.jpg" {
		t.Fatalf("disk and batch = %q, %v", got, err)
	}
}

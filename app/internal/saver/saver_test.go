package saver

import (
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"picturecut/internal/crop"
	"picturecut/internal/naming"
)

func writeSource(t *testing.T) string {
	t.Helper()
	src := image.NewNRGBA(image.Rect(0, 0, 100, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 100; x++ {
			if x < 50 {
				src.SetNRGBA(x, y, color.NRGBA{255, 0, 0, 255})
			} else {
				src.SetNRGBA(x, y, color.NRGBA{0, 0, 255, 255})
			}
		}
	}
	path := filepath.Join(t.TempDir(), "source.jpg")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, src, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSaveWritesTheCroppedRect(t *testing.T) {
	source := writeSource(t)
	out := filepath.Join(t.TempDir(), "out.png")
	err := Save(Request{
		Source: source,
		Output: out,
		Rect:   crop.Rect{X: 50, Y: 20, W: 50, H: 40},
		Format: naming.PNG,
	}, naming.High)
	if err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if b := got.Bounds(); b.Dx() != 50 || b.Dy() != 40 {
		t.Fatalf("output is %v, want 50×40", b)
	}
	for _, p := range []image.Point{{0, 0}, {49, 39}} {
		c := color.NRGBAModel.Convert(got.At(p.X, p.Y)).(color.NRGBA)
		if c.B > 200 && c.R < 60 {
			continue
		}
		t.Errorf("pixel %v = %+v, want the right half's blue", p, c)
	}
}

func TestSaveLeavesNoFileWhenTheSourceIsUnreadable(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.jpg")
	err := Save(Request{
		Source: filepath.Join(dir, "missing.jpg"),
		Output: out,
		Rect:   crop.Rect{W: 10, H: 10},
		Format: naming.JPEG,
	}, naming.Compressed)
	if err == nil {
		t.Fatal("Save succeeded, want an error")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("left %d files behind", len(entries))
	}
}

func TestSaveKeepsReadablePermissions(t *testing.T) {
	src := writeSource(t)
	out := filepath.Join(t.TempDir(), "out.jpg")
	if err := Save(Request{Source: src, Output: out, Format: naming.JPEG}, naming.Compressed); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("mode = %o, want 644", perm)
	}
}

func TestSaveRemovesTempFileAfterEncodeFailure(t *testing.T) {
	src := writeSource(t)
	dir := t.TempDir()
	out := filepath.Join(dir, "out.webp")
	if err := Save(Request{Source: src, Output: out, Format: naming.Format("WEBP")}, naming.Compressed); err == nil {
		t.Fatal("Save accepted an unsupported format")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".picturecut-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

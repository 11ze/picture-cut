package saver

import (
	"context"
	"errors"
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
	_, err := Save(context.Background(), Request{
		Source: source,
		Output: out,
		Rect:   crop.Rect{X: 50, Y: 20, W: 50, H: 40},
		Format: naming.PNG,
	}, naming.High, nil)
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
	_, err := Save(context.Background(), Request{
		Source: filepath.Join(dir, "missing.jpg"),
		Output: out,
		Rect:   crop.Rect{W: 10, H: 10},
		Format: naming.JPEG,
	}, naming.Compressed, nil)
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
	if _, err := Save(context.Background(), Request{Source: src, Output: out, Format: naming.JPEG}, naming.Compressed, nil); err != nil {
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
	if _, err := Save(context.Background(), Request{Source: src, Output: out, Format: naming.Format("WEBP")}, naming.Compressed, nil); err == nil {
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

func TestSaveReusesEncodedOutputAfterCollision(t *testing.T) {
	source := writeSource(t)
	dir := t.TempDir()
	occupied := filepath.Join(dir, "out.jpg")
	next := filepath.Join(dir, "out-2.jpg")
	if err := os.WriteFile(occupied, []byte("existing output"), 0o644); err != nil {
		t.Fatal(err)
	}

	written, err := Save(context.Background(), Request{
		Source: source, Output: occupied, Format: naming.JPEG,
	}, naming.High, func() (string, error) {
		return next, os.Remove(source)
	})
	if err != nil || written != next {
		t.Fatalf("saved %q, want %q; error: %v", written, next, err)
	}
	original, err := os.ReadFile(occupied)
	if err != nil || string(original) != "existing output" {
		t.Fatalf("existing output = %q, error: %v", original, err)
	}
	f, err := os.Open(next)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := jpeg.Decode(f); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("output entries = %v, error: %v", entries, err)
	}
}

func TestSaveCleansUpWhenCanceledAfterCollision(t *testing.T) {
	source := writeSource(t)
	dir := t.TempDir()
	occupied := filepath.Join(dir, "out.jpg")
	if err := os.WriteFile(occupied, []byte("existing output"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	written, err := Save(ctx, Request{
		Source: source, Output: occupied, Format: naming.JPEG,
	}, naming.High, func() (string, error) {
		cancel()
		return filepath.Join(dir, "out-2.jpg"), nil
	})
	if written != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("saved %q, error: %v; want cancellation", written, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "out.jpg" {
		t.Fatalf("output entries = %v, error: %v", entries, err)
	}
}

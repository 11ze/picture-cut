package imageinfo

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// threeByTwo has one distinct color per pixel so a transform is unambiguous.
func threeByTwo() *image.NRGBA {
	m := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	colors := []color.NRGBA{
		{10, 0, 0, 255}, {20, 0, 0, 255}, {30, 0, 0, 255},
		{40, 0, 0, 255}, {50, 0, 0, 255}, {60, 0, 0, 255},
	}
	for i, c := range colors {
		m.SetNRGBA(i%3, i/3, c)
	}
	return m
}

func at(m image.Image, x, y int) color.NRGBA {
	return color.NRGBAModel.Convert(m.At(x, y)).(color.NRGBA)
}

func TestOrientation(t *testing.T) {
	src := threeByTwo()
	cases := []struct {
		orientation int
		w, h        int
		want        []color.NRGBA // row-major
	}{
		{1, 3, 2, []color.NRGBA{{10, 0, 0, 255}, {20, 0, 0, 255}, {30, 0, 0, 255}, {40, 0, 0, 255}, {50, 0, 0, 255}, {60, 0, 0, 255}}},
		{2, 3, 2, []color.NRGBA{{30, 0, 0, 255}, {20, 0, 0, 255}, {10, 0, 0, 255}, {60, 0, 0, 255}, {50, 0, 0, 255}, {40, 0, 0, 255}}},
		{3, 3, 2, []color.NRGBA{{60, 0, 0, 255}, {50, 0, 0, 255}, {40, 0, 0, 255}, {30, 0, 0, 255}, {20, 0, 0, 255}, {10, 0, 0, 255}}},
		{4, 3, 2, []color.NRGBA{{40, 0, 0, 255}, {50, 0, 0, 255}, {60, 0, 0, 255}, {10, 0, 0, 255}, {20, 0, 0, 255}, {30, 0, 0, 255}}},
		{5, 2, 3, []color.NRGBA{{10, 0, 0, 255}, {40, 0, 0, 255}, {20, 0, 0, 255}, {50, 0, 0, 255}, {30, 0, 0, 255}, {60, 0, 0, 255}}},
		{6, 2, 3, []color.NRGBA{{40, 0, 0, 255}, {10, 0, 0, 255}, {50, 0, 0, 255}, {20, 0, 0, 255}, {60, 0, 0, 255}, {30, 0, 0, 255}}},
		{7, 2, 3, []color.NRGBA{{60, 0, 0, 255}, {30, 0, 0, 255}, {50, 0, 0, 255}, {20, 0, 0, 255}, {40, 0, 0, 255}, {10, 0, 0, 255}}},
		{8, 2, 3, []color.NRGBA{{30, 0, 0, 255}, {60, 0, 0, 255}, {20, 0, 0, 255}, {50, 0, 0, 255}, {10, 0, 0, 255}, {40, 0, 0, 255}}},
	}
	for _, c := range cases {
		got := Orient(src, c.orientation)
		b := got.Bounds()
		if b.Dx() != c.w || b.Dy() != c.h {
			t.Errorf("orientation %d: %dx%d, want %dx%d", c.orientation, b.Dx(), b.Dy(), c.w, c.h)
			continue
		}
		for i, want := range c.want {
			x, y := i%c.w, i/c.w
			if have := at(got, x, y); have != want {
				t.Errorf("orientation %d pixel %d,%d = %+v, want %+v", c.orientation, x, y, have, want)
			}
		}
	}
}

// exifWithOrientation builds the bytes after the "Exif\0\0" marker.
func exifWithOrientation(orientation uint16) []byte {
	var b bytes.Buffer
	b.WriteString("II")
	binary.Write(&b, binary.LittleEndian, uint16(42))
	binary.Write(&b, binary.LittleEndian, uint32(8))
	binary.Write(&b, binary.LittleEndian, uint16(1)) // one entry
	binary.Write(&b, binary.LittleEndian, uint16(0x0112))
	binary.Write(&b, binary.LittleEndian, uint16(3)) // SHORT
	binary.Write(&b, binary.LittleEndian, uint32(1))
	binary.Write(&b, binary.LittleEndian, orientation)
	binary.Write(&b, binary.LittleEndian, uint32(0)) // no next IFD
	return b.Bytes()
}

func TestParseOrientation(t *testing.T) {
	for _, want := range []uint16{1, 3, 6, 8} {
		payload := append([]byte("Exif\x00\x00"), exifWithOrientation(want)...)
		got := parseOrientation(payload)
		if got != int(want) {
			t.Errorf("parseOrientation(%d) = %d", want, got)
		}
	}
	if got := parseOrientation([]byte("nonsense")); got != 1 {
		t.Errorf("parseOrientation(garbage) = %d, want 1", got)
	}
}

func writeTemp(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func jpegBytes(t *testing.T, m image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, m, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func pngBytes(t *testing.T, m image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestLoadReadsFormatAndSize(t *testing.T) {
	src := threeByTwo()
	jpg := writeTemp(t, "photo.JPG", jpegBytes(t, src))
	pngPath := writeTemp(t, "icon.png", pngBytes(t, src))

	info, img, err := Load(jpg)
	if err != nil {
		t.Fatal(err)
	}
	if info.Format != "JPEG" || info.Width != 3 || info.Height != 2 || info.Name != "photo.JPG" {
		t.Errorf("Load(jpg) = %+v", info)
	}
	if info.Bytes != int64(len(jpegBytes(t, src))) {
		t.Errorf("Bytes = %d", info.Bytes)
	}
	if img == nil || img.Bounds().Dx() != 3 {
		t.Errorf("image not returned")
	}

	info, _, err = Load(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Format != "PNG" || info.Width != 3 || info.Height != 2 {
		t.Errorf("Load(png) = %+v", info)
	}
}

func TestLoadRejectsOtherFormats(t *testing.T) {
	dir := t.TempDir()
	cases := map[string][]byte{
		"animation.gif":  []byte("GIF89a"),
		"disguised.png":  []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
		"broken.png":     []byte{137, 80, 78, 71, 13, 10, 26, 10},
		"image.svg":      []byte("<svg/>"),
		"truncated.jpeg": []byte{0xff, 0xd8, 0xff},
	}
	for name, data := range cases {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Load(path); err == nil {
			t.Errorf("Load(%s) succeeded, want an error", name)
		}
	}
}

func TestThumbnailFitsMax(t *testing.T) {
	big := image.NewNRGBA(image.Rect(0, 0, 400, 200))
	for i := range big.Pix {
		big.Pix[i] = uint8(i * 7)
	}
	data, err := Thumbnail(big, 96)
	if err != nil {
		t.Fatal(err)
	}
	thumb, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if b := thumb.Bounds(); b.Dx() > 96 || b.Dy() > 96 || b.Dx() != 96 {
		t.Errorf("thumbnail %v does not fit 96", b)
	}
}

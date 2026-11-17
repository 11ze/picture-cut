package encode

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"testing"

	"picturecut/internal/naming"
)

func gradient(w, h int) image.Image {
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			m.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 128, A: 255})
		}
	}
	return m
}

// noise looks like a photo to the encoder: every pixel differs.
func noise(w, h int) image.Image {
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	seed := uint32(12345)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			seed = seed*1664525 + 1013904223
			m.SetNRGBA(x, y, color.NRGBA{R: uint8(seed >> 24), G: uint8(seed >> 16), B: uint8(seed >> 8), A: 255})
		}
	}
	return m
}

func encodeBytes(t *testing.T, m image.Image, format naming.Format, q naming.Quality) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := Encode(&buf, m, format, q); err != nil {
		t.Fatalf("Encode(%s, %s): %v", format, q, err)
	}
	return buf.Bytes()
}

func TestJPEGKeepsDimensionsAndHighQualityIsBigger(t *testing.T) {
	src := noise(320, 240)
	standard := encodeBytes(t, src, naming.JPEG, naming.Compressed)
	high := encodeBytes(t, src, naming.JPEG, naming.High)

	got, _, err := image.Decode(bytes.NewReader(standard))
	if err != nil {
		t.Fatal(err)
	}
	if b := got.Bounds(); b.Dx() != 320 || b.Dy() != 240 {
		t.Errorf("decoded %v, want 320×240", b)
	}
	if len(high) <= len(standard) {
		t.Errorf("high quality is %d bytes, standard %d; want high to be larger", len(high), len(standard))
	}
	if _, _, err := image.Decode(bytes.NewReader(high)); err != nil {
		t.Fatalf("high quality is not a valid JPEG: %v", err)
	}
}

func TestPNGLosslessKeepsEveryPixel(t *testing.T) {
	src := gradient(97, 61)
	data := encodeBytes(t, src, naming.PNG, naming.High)
	got, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 61; y++ {
		for x := 0; x < 97; x++ {
			want := color.NRGBAModel.Convert(src.At(x, y)).(color.NRGBA)
			have := color.NRGBAModel.Convert(got.At(x, y)).(color.NRGBA)
			if want != have {
				t.Fatalf("pixel %d,%d = %+v, want %+v", x, y, have, want)
			}
		}
	}
}

func TestQuantizeReproducesFewColorsExactly(t *testing.T) {
	colors := []color.NRGBA{{255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255}}
	src := image.NewNRGBA(image.Rect(0, 0, 30, 30))
	for y := 0; y < 30; y++ {
		for x := 0; x < 30; x++ {
			src.SetNRGBA(x, y, colors[(x+y)%3])
		}
	}
	got := Quantize(src, 256)
	if n := len(got.Palette); n > 256 {
		t.Fatalf("palette has %d colors", n)
	}
	for y := 0; y < 30; y++ {
		for x := 0; x < 30; x++ {
			want := color.NRGBAModel.Convert(src.At(x, y)).(color.NRGBA)
			have := color.NRGBAModel.Convert(got.At(x, y)).(color.NRGBA)
			if want != have {
				t.Fatalf("pixel %d,%d = %+v, want %+v", x, y, have, want)
			}
		}
	}
}

func TestQuantizeKeepsTransparency(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 60, 40))
	for y := 0; y < 40; y++ {
		for x := 0; x < 60; x++ {
			switch {
			case x < 20:
				src.SetNRGBA(x, y, color.NRGBA{200, 40, 20, 255})
			case x < 40:
				src.SetNRGBA(x, y, color.NRGBA{200, 40, 20, 128})
			default:
				src.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 0})
			}
		}
	}
	got := Quantize(src, 256)
	if n := len(got.Palette); n > 256 {
		t.Fatalf("palette has %d colors", n)
	}

	transparent := 0
	for y := 0; y < 40; y++ {
		for x := 40; x < 60; x++ {
			if _, _, _, a := got.At(x, y).RGBA(); a == 0 {
				transparent++
			}
		}
	}
	if transparent != 20*40 {
		t.Errorf("kept %d transparent pixels, want %d", transparent, 20*40)
	}

	halves := 0
	for y := 0; y < 40; y++ {
		_, _, _, a := got.At(30, y).RGBA()
		if a > 100*257 && a < 160*257 {
			halves++
		}
	}
	if halves != 40 {
		t.Errorf("%d half-transparent pixels, want 40", halves)
	}
}

func TestQuantizedPNGIsSmallerThanLosslessForPhotos(t *testing.T) {
	src := noise(256, 256)
	lossless := encodeBytes(t, src, naming.PNG, naming.High)
	standard := encodeBytes(t, src, naming.PNG, naming.Compressed)
	if len(standard) >= len(lossless) {
		t.Errorf("standard %d bytes is not smaller than lossless %d bytes", len(standard), len(lossless))
	}
	if _, err := png.Decode(bytes.NewReader(standard)); err != nil {
		t.Fatalf("standard tier is not a valid PNG: %v", err)
	}
}

func TestQuantizeQualityOnGradient(t *testing.T) {
	src := gradient(200, 120)
	got := Quantize(src, 256)
	var sum float64
	for y := 0; y < 120; y++ {
		for x := 0; x < 200; x++ {
			a := color.NRGBAModel.Convert(src.At(x, y)).(color.NRGBA)
			b := color.NRGBAModel.Convert(got.At(x, y)).(color.NRGBA)
			sum += math.Abs(float64(a.R)-float64(b.R)) + math.Abs(float64(a.G)-float64(b.G)) + math.Abs(float64(a.B)-float64(b.B))
		}
	}
	mean := sum / float64(200*120*3)
	if mean > 8 {
		t.Errorf("mean channel error %.1f is too high for a 256-color gradient", mean)
	}
}

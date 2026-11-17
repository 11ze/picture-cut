// Package crop turns a crop rectangle given as fractions of an image into the
// pixel rectangle the page shows and the exporter writes.
package crop

import "math"

// Norm is a crop rectangle in fractions of the image, each in 0..1.
type Norm struct {
	X, Y, W, H float64
}

// Rect is a crop rectangle in image pixels.
type Rect struct {
	X, Y, W, H int
}

// PixelRect converts a normalized crop to pixels. The size rounds to the
// nearest pixel and is at least one pixel; the origin is pulled back inside
// the image. crop.ts does the same, so the page's numbers match the file.
func PixelRect(imgW, imgH int, n Norm) Rect {
	if imgW <= 0 || imgH <= 0 {
		return Rect{}
	}
	w := clampInt(round(n.W*float64(imgW)), 1, imgW)
	h := clampInt(round(n.H*float64(imgH)), 1, imgH)
	x := clampInt(round(n.X*float64(imgW)), 0, imgW-w)
	y := clampInt(round(n.Y*float64(imgH)), 0, imgH-h)
	return Rect{X: x, Y: y, W: w, H: h}
}

// round is math.Round, spelled out so the page's Math.round has a JSON twin.
func round(f float64) int {
	return int(math.Round(f))
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

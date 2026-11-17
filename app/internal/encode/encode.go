// Package encode writes cropped images in the source format at the chosen
// quality tier. The standard PNG tier reduces the palette; the high tier keeps
// every color.
package encode

import (
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"sort"

	"picturecut/internal/naming"
)

// Encode writes m in format at quality. JPEG uses q80 for the standard tier and
// q95 for the high one; PNG keeps every color only at the high tier.
func Encode(w io.Writer, m image.Image, format naming.Format, quality naming.Quality) error {
	switch format {
	case naming.JPEG:
		q := 80
		if quality == naming.High {
			q = 95
		}
		return jpeg.Encode(w, m, &jpeg.Options{Quality: q})
	case naming.PNG:
		var out image.Image = m
		if quality != naming.High {
			out = Quantize(m, 256)
		}
		return (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(w, out)
	}
	return fmt.Errorf("encode: unknown format %q", format)
}

const (
	bucketBits   = 5
	bucketLevels = 1 << bucketBits
	bucketMask   = bucketLevels - 1
)

// acc sums the pixels of one color bucket.
type acc struct {
	n          uint64
	r, g, b, a uint64
}

func bucketKey(c color.NRGBA) uint32 {
	return uint32(c.R>>(8-bucketBits))<<(bucketBits*3) |
		uint32(c.G>>(8-bucketBits))<<(bucketBits*2) |
		uint32(c.B>>(8-bucketBits))<<bucketBits |
		uint32(c.A>>(8-bucketBits))
}

// bucketColor is the representative color of a bucket, at its center.
func bucketColor(k uint32) color.NRGBA {
	half := uint8(1 << (7 - bucketBits))
	return color.NRGBA{
		R: uint8(k>>(bucketBits*3)&bucketMask)<<(8-bucketBits) | half,
		G: uint8(k>>(bucketBits*2)&bucketMask)<<(8-bucketBits) | half,
		B: uint8(k>>bucketBits&bucketMask)<<(8-bucketBits) | half,
		A: uint8(k&bucketMask)<<(8-bucketBits) | half,
	}
}

// Quantize reduces m to a palette of at most colors entries. Its palette
// keeps transparency, and the most frequent color survives exactly, so a
// transparent background stays transparent.
func Quantize(m image.Image, colors int) *image.Paletted {
	if colors < 1 {
		colors = 1
	}
	if colors > 256 {
		colors = 256
	}
	bounds := m.Bounds()
	hist := histogram(m)
	if len(hist) == 0 {
		pal := color.Palette{color.NRGBA{}}
		return image.NewPaletted(bounds, pal)
	}

	palette, lookup := buildPalette(hist, colors)

	out := image.NewPaletted(bounds, palette)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			c := color.NRGBAModel.Convert(m.At(x, y)).(color.NRGBA)
			out.SetColorIndex(x, y, lookup[bucketKey(c)])
		}
	}
	return out
}

func histogram(m image.Image) map[uint32]*acc {
	bounds := m.Bounds()
	hist := make(map[uint32]*acc, 1024)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			c := color.NRGBAModel.Convert(m.At(x, y)).(color.NRGBA)
			k := bucketKey(c)
			a := hist[k]
			if a == nil {
				a = &acc{}
				hist[k] = a
			}
			a.n++
			a.r += uint64(c.R)
			a.g += uint64(c.G)
			a.b += uint64(c.B)
			a.a += uint64(c.A)
		}
	}
	return hist
}

// box is a set of buckets that becomes one palette entry.
type box struct {
	keys []uint32
}

func (b box) weight(hist map[uint32]*acc) uint64 {
	var n uint64
	for _, k := range b.keys {
		n += hist[k].n
	}
	return n
}

// span returns the channel with the widest range and that range.
func (b box) span() (axis, width int) {
	var lo, hi [4]int
	for i := range lo {
		lo[i] = 1 << 8
	}
	for _, k := range b.keys {
		v := [4]int{int(k >> (bucketBits * 3) & bucketMask), int(k >> (bucketBits * 2) & bucketMask), int(k >> bucketBits & bucketMask), int(k & bucketMask)}
		for i := range v {
			if v[i] < lo[i] {
				lo[i] = v[i]
			}
			if v[i] > hi[i] {
				hi[i] = v[i]
			}
		}
	}
	width = -1
	for i := range lo {
		if d := hi[i] - lo[i]; d > width {
			axis, width = i, d
		}
	}
	return axis, width
}

func channel(k uint32, axis int) int {
	return int(k >> (bucketBits * (3 - axis)) & bucketMask)
}

func split(b box, hist map[uint32]*acc) (box, box) {
	axis, _ := b.span()
	keys := append([]uint32(nil), b.keys...)
	sort.Slice(keys, func(i, j int) bool { return channel(keys[i], axis) < channel(keys[j], axis) })

	var total uint64
	for _, k := range keys {
		total += hist[k].n
	}
	var running uint64
	cut := 1
	for i, k := range keys {
		running += hist[k].n
		if running*2 >= total && i < len(keys)-1 {
			cut = i + 1
			break
		}
	}
	if cut < 1 {
		cut = 1
	}
	if cut > len(keys)-1 {
		cut = len(keys) - 1
	}
	return box{keys: keys[:cut]}, box{keys: keys[cut:]}
}

func buildPalette(hist map[uint32]*acc, colors int) (color.Palette, map[uint32]uint8) {
	keys := make([]uint32, 0, len(hist))
	for k := range hist {
		keys = append(keys, k)
	}
	boxes := []box{{keys: keys}}
	for len(boxes) < colors {
		best := -1
		var bestScore float64
		for i, b := range boxes {
			if len(b.keys) < 2 {
				continue
			}
			_, width := b.span()
			score := float64(width) * float64(b.weight(hist))
			if score > bestScore {
				best, bestScore = i, score
			}
		}
		if best < 0 {
			break
		}
		a, b := split(boxes[best], hist)
		boxes[best] = a
		boxes = append(boxes, b)
	}

	palette := make(color.Palette, 0, len(boxes))
	for _, b := range boxes {
		var n, r, g, bl, al uint64
		for _, k := range b.keys {
			a := hist[k]
			n += a.n
			r += a.r
			g += a.g
			bl += a.b
			al += a.a
		}
		palette = append(palette, color.NRGBA{
			R: uint8(r / n), G: uint8(g / n), B: uint8(bl / n), A: uint8(al / n),
		})
	}

	// Keep the most common color exact: a transparent or white background must
	// not gain a tint from averaging.
	var dominant uint32
	var dominantCount uint64
	for k, a := range hist {
		if a.n > dominantCount {
			dominant, dominantCount = k, a.n
		}
	}
	want := hist[dominant]
	exact := color.NRGBA{
		R: uint8(want.r / want.n), G: uint8(want.g / want.n),
		B: uint8(want.b / want.n), A: uint8(want.a / want.n),
	}
	hasExact := false
	for _, c := range palette {
		if c == exact {
			hasExact = true
			break
		}
	}
	if !hasExact {
		palette = append(color.Palette{exact}, palette...)
		if len(palette) > colors {
			palette = palette[:colors]
		}
	}

	lookup := make(map[uint32]uint8, len(hist))
	for k := range hist {
		lookup[k] = nearest(palette, bucketColor(k))
	}
	return palette, lookup
}

func nearest(palette color.Palette, c color.NRGBA) uint8 {
	best, bestDist := 0, int64(1)<<62
	for i, p := range palette {
		q := color.NRGBAModel.Convert(p).(color.NRGBA)
		dr := int64(c.R) - int64(q.R)
		dg := int64(c.G) - int64(q.G)
		db := int64(c.B) - int64(q.B)
		da := int64(c.A) - int64(q.A)
		d := dr*dr + dg*dg + db*db + da*da
		if d < bestDist {
			best, bestDist = i, d
		}
	}
	return uint8(best)
}

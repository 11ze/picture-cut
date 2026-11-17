// Package imageinfo validates image files, decodes them with the same
// orientation a browser would show, and makes list thumbnails.
package imageinfo

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"

	"picturecut/internal/naming"
)

// ErrUnsupported is returned for files that are not a readable JPEG or PNG.
var ErrUnsupported = errors.New("unsupported image")

// Info describes one imported image. Width and Height are the oriented size.
type Info struct {
	Path   string
	Name   string
	Width  int
	Height int
	Bytes  int64
	Format naming.Format
}

var pngMagic = []byte{137, 80, 78, 71, 13, 10, 26, 10}

// Load checks path, decodes it, and returns its metadata with the pixels
// already rotated the way the page shows them.
func Load(path string) (Info, *image.NRGBA, error) {
	ext := strings.ToLower(filepath.Ext(path))
	var format naming.Format
	switch ext {
	case ".jpg", ".jpeg":
		format = naming.JPEG
	case ".png":
		format = naming.PNG
	default:
		return Info{}, nil, fmt.Errorf("%w: %s", ErrUnsupported, ext)
	}

	f, err := os.Open(path)
	if err != nil {
		return Info{}, nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return Info{}, nil, err
	}
	head, err := io.ReadAll(io.LimitReader(f, 128<<10))
	if err != nil {
		return Info{}, nil, err
	}
	switch format {
	case naming.JPEG:
		if len(head) < 3 || head[0] != 0xFF || head[1] != 0xD8 || head[2] != 0xFF {
			return Info{}, nil, fmt.Errorf("%w: not a JPEG", ErrUnsupported)
		}
	case naming.PNG:
		if !bytes.HasPrefix(head, pngMagic) {
			return Info{}, nil, fmt.Errorf("%w: not a PNG", ErrUnsupported)
		}
	}

	orientation := 1
	if format == naming.JPEG {
		orientation = parseOrientation(head)
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Info{}, nil, err
	}
	m, _, err := image.Decode(f)
	if err != nil {
		return Info{}, nil, fmt.Errorf("%w: %v", ErrUnsupported, err)
	}
	oriented := Orient(m, orientation)
	bounds := oriented.Bounds()

	return Info{
		Path:   path,
		Name:   filepath.Base(path),
		Width:  bounds.Dx(),
		Height: bounds.Dy(),
		Bytes:  stat.Size(),
		Format: format,
	}, oriented, nil
}

// parseOrientation reads the EXIF orientation tag from the first bytes of a
// JPEG. It returns 1 when the file has none.
func parseOrientation(b []byte) int {
	i := bytes.Index(b, []byte("Exif\x00\x00"))
	if i < 0 {
		return 1
	}
	tiff := b[i+6:]
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 1
	}
	offset := int(order.Uint32(tiff[4:8]))
	if offset < 8 || offset+2 > len(tiff) {
		return 1
	}
	count := int(order.Uint16(tiff[offset:]))
	for i := 0; i < count; i++ {
		entry := offset + 2 + i*12
		if entry+12 > len(tiff) {
			return 1
		}
		tag := order.Uint16(tiff[entry:])
		typ := order.Uint16(tiff[entry+2:])
		n := order.Uint32(tiff[entry+4:])
		if tag == 0x0112 && typ == 3 && n >= 1 {
			v := int(order.Uint16(tiff[entry+8:]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// Orient returns m with the EXIF orientation applied, so its width and height
// swap for the quarter turns. It always returns a new image except for
// orientation 1 on an NRGBA source.
func Orient(m image.Image, orientation int) *image.NRGBA {
	src := toNRGBA(m)
	if orientation <= 1 || orientation > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch orientation {
			case 2:
				sx, sy = w-1-x, y
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sx, sy = x, h-1-y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			dst.SetNRGBA(x, y, src.NRGBAAt(sx, sy))
		}
	}
	return dst
}

func toNRGBA(m image.Image) *image.NRGBA {
	if n, ok := m.(*image.NRGBA); ok {
		return n
	}
	b := m.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), m, b.Min, draw.Src)
	return dst
}

// Thumbnail returns a JPEG no larger than max on either side, for the list.
func Thumbnail(m image.Image, max int) ([]byte, error) {
	b := m.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("empty image")
	}
	scale := float64(max) / float64(w)
	if s := float64(max) / float64(h); s < scale {
		scale = s
	}
	if scale > 1 {
		scale = 1
	}
	dw := maxInt(1, int(float64(w)*scale+0.5))
	dh := maxInt(1, int(float64(h)*scale+0.5))
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), m, b, draw.Src, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

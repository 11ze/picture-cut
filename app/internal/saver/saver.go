// Package saver writes one cropped image to disk.
package saver

import (
	"image"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"

	"picturecut/internal/crop"
	"picturecut/internal/encode"
	"picturecut/internal/imageinfo"
	"picturecut/internal/naming"
)

// Request is one output file.
type Request struct {
	Source string        // the original file
	Output string        // where to write it, already unique
	Rect   crop.Rect     // the crop in source pixels
	Format naming.Format // the source's format
}

// Save decodes Source, crops Rect, and encodes it to Output. It writes through
// a temporary file, so a failure leaves neither a partial output nor a stray
// file behind.
func Save(req Request, quality naming.Quality) error {
	_, img, err := imageinfo.Load(req.Source)
	if err != nil {
		return err
	}
	b := img.Bounds()
	rect := req.Rect
	if rect.W < 1 || rect.H < 1 {
		rect = crop.Rect{X: 0, Y: 0, W: b.Dx(), H: b.Dy()}
	}
	if rect.X < 0 {
		rect.X = 0
	}
	if rect.Y < 0 {
		rect.Y = 0
	}
	if rect.X+rect.W > b.Dx() {
		rect.W = b.Dx() - rect.X
	}
	if rect.Y+rect.H > b.Dy() {
		rect.H = b.Dy() - rect.Y
	}

	cropped := image.NewNRGBA(image.Rect(0, 0, rect.W, rect.H))
	draw.Draw(cropped, cropped.Bounds(), img, image.Pt(rect.X, rect.Y), draw.Src)

	tmp, err := os.CreateTemp(filepath.Dir(req.Output), ".picturecut-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := encode.Encode(tmp, cropped, req.Format, quality); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	// CreateTemp makes the file private; output images should be readable.
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, req.Output); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

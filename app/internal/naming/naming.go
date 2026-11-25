// Package naming builds the output file names shown in the app and used when
// saving, and keeps them from overwriting existing files.
package naming

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Format is an output format, the source image's own.
type Format string

const (
	JPEG Format = "JPEG"
	PNG  Format = "PNG"
)

// Quality is the shared output quality tier.
type Quality string

const (
	High       Quality = "high"
	Compressed Quality = "compressed"
)

// ParseQuality maps the page's quality tier to a value. An unknown tier means
// the compressed one, so a bad setting never stops a save.
func ParseQuality(s string) Quality {
	if s == string(High) {
		return High
	}
	return Compressed
}

// StampFormat is the time layout used in file names.
const StampFormat = "20060102-150405"

// Name builds the design's file name, such as
// city_16x9_q80_20261117-103842.jpg. The extension keeps its case.
func Name(stem, ext, ratio string, format Format, quality Quality, stamp string) string {
	parts := []string{stem, strings.ReplaceAll(ratio, ":", "x")}
	if quality == Compressed {
		if format == PNG {
			parts = append(parts, "compressed")
		} else {
			parts = append(parts, "q80")
		}
	}
	parts = append(parts, stamp)
	return strings.Join(parts, "_") + ext
}

// Unique returns name, or a name with -2, -3, ... before the extension when
// that file already exists in dir.
func Unique(dir, name string) (string, error) {
	return Reserve(dir, name, nil)
}

// Reserve returns a name that exists neither in dir nor in taken, and records
// it in taken. The sheet reserves the names of the images it will write, so
// its preview matches what Save writes for a batch with two same-stem images.
func Reserve(dir, name string, taken map[string]bool) (string, error) {
	stem, ext := Split(name)
	for i := 1; ; i++ {
		candidate := name
		if i > 1 {
			candidate = stem + "-" + strconv.Itoa(i) + ext
		}
		if taken[candidate] {
			continue
		}
		_, err := os.Lstat(filepath.Join(dir, candidate))
		if err == nil {
			continue
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if taken != nil {
			taken[candidate] = true
		}
		return candidate, nil
	}
}

// Split separates a file name into its stem and extension, extension included.
func Split(name string) (stem, ext string) {
	ext = filepath.Ext(name)
	return strings.TrimSuffix(name, ext), ext
}

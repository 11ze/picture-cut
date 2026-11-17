// Package settings persists the shared output settings between launches.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"

	"picturecut/internal/naming"
)

// Settings are the output settings shared by every image in the list.
type Settings struct {
	InPlace bool           `json:"inPlace"`
	OutDir  string         `json:"outDir"`
	Quality naming.Quality `json:"quality"`
}

// Load reads path. A missing or unreadable file, and one that does not decode,
// yield fallback, so a damaged file never stops the app from starting.
func Load(path string, fallback Settings) Settings {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return fallback
	}
	if s.Quality != naming.High && s.Quality != naming.Compressed {
		s.Quality = fallback.Quality
	}
	if s.OutDir == "" {
		s.OutDir = fallback.OutDir
	}
	return s
}

// Save writes s to path through a temporary file, so a crash leaves either the
// old file or the new one, never a truncated one.
func Save(path string, s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".settings-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

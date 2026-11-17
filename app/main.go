package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"picturecut/internal/crop"
	"picturecut/internal/imageinfo"
	"picturecut/internal/naming"
	"picturecut/internal/saver"
	"picturecut/internal/settings"
)

// Image is one imported image as the page sees it.
type Image struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Bytes   int64  `json:"bytes"`
	Format  string `json:"format"`
	Thumb   string `json:"thumb"`
	Preview string `json:"preview"`
}

// ImportResult is what an import added and what it had to skip.
type ImportResult struct {
	Images  []Image `json:"images"`
	Skipped int     `json:"skipped"`
}

// NameRequest asks for the output file name of one image.
type NameRequest struct {
	ID      string `json:"id"`
	Ratio   string `json:"ratio"`
	Applied bool   `json:"applied"`
}

// Crop is a crop rectangle in fractions of the image.
type Crop struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// SaveItem is one image the page wants written.
type SaveItem struct {
	ID    string `json:"id"`
	Ratio string `json:"ratio"`
	Crop  Crop   `json:"crop"`
}

// SaveRequest is one run of the save sheet.
type SaveRequest struct {
	Items   []SaveItem `json:"items"`
	Quality string     `json:"quality"`
	InPlace bool       `json:"inPlace"`
	OutDir  string     `json:"outDir"`
}

// Progress is one file the batch moved past, written or failed.
type Progress struct {
	Done  int    `json:"done"`
	Total int    `json:"total"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// Failure is one file that could not be written.
type Failure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// Report is the outcome of a save run.
type Report struct {
	Saved    []string  `json:"saved"`
	Failed   []Failure `json:"failed"`
	Dir      string    `json:"dir"`
	Canceled bool      `json:"canceled"`
}

// SettingsModel is the shared output settings as the page sees them.
type SettingsModel struct {
	InPlace bool   `json:"inPlace"`
	OutDir  string `json:"outDir"`
	Quality string `json:"quality"`
}

type entry struct {
	info imageinfo.Info
}

// Library is the Go side of the app: the imported images, the saved settings,
// and the files the page reads over the app's protocols.
type Library struct {
	mu      sync.Mutex
	entries map[string]entry
	thumbs  map[string][]byte
	dataDir string
	stamp   string
	conf    settings.Settings
}

func newLibrary() *Library {
	return &Library{
		entries: make(map[string]entry),
		thumbs:  make(map[string][]byte),
		stamp:   time.Now().Format(naming.StampFormat),
	}
}

func (l *Library) settingsPath() string { return filepath.Join(l.dataDir, "settings.json") }

func (l *Library) loadSettings() {
	home, _ := os.UserHomeDir()
	fallback := settings.Settings{
		InPlace: true,
		OutDir:  filepath.Join(home, "Desktop", "裁剪输出"),
		Quality: naming.Compressed,
	}
	l.conf = settings.Load(l.settingsPath(), fallback)
}

// Settings returns the shared output settings.
func (l *Library) Settings() SettingsModel {
	l.mu.Lock()
	defer l.mu.Unlock()
	return SettingsModel{InPlace: l.conf.InPlace, OutDir: l.conf.OutDir, Quality: string(l.conf.Quality)}
}

// UpdateSettings stores the shared output settings.
func (l *Library) UpdateSettings(s SettingsModel) error {
	q := naming.Compressed
	if s.Quality == string(naming.High) {
		q = naming.High
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.conf = settings.Settings{InPlace: s.InPlace, OutDir: s.OutDir, Quality: q}
	// Held during the write: two quick changes must not land out of order.
	return settings.Save(l.settingsPath(), l.conf)
}

// PickImages asks for image files and imports the ones it can read.
func (l *Library) PickImages(ctx context.Context) (ImportResult, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:   mygo.CallerWindow(ctx),
		Title:    "打开图片",
		Filters:  []mygo.FileFilter{{Name: "图片", Extensions: []string{"jpg", "jpeg", "png"}}},
		Multiple: true,
	})
	if err != nil {
		return ImportResult{}, err
	}
	return l.importPaths(paths), nil
}

// PickFolder asks for a folder and imports every JPEG and PNG under it.
func (l *Library) PickFolder(ctx context.Context) (ImportResult, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:    mygo.CallerWindow(ctx),
		Title:     "打开文件夹",
		Directory: true,
	})
	if err != nil {
		return ImportResult{}, err
	}
	var files []string
	for _, root := range paths {
		files = append(files, collectImages(root)...)
	}
	return l.importPaths(files), nil
}

// collectImages lists the JPEG and PNG files under root, in walk order,
// without hidden files or the insides of hidden folders.
func collectImages(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".jpg", ".jpeg", ".png":
			files = append(files, path)
		}
		return nil
	})
	return files
}

// ChooseOutputDir asks where the outputs go when they are not next to the
// sources. It returns "" when the dialog is canceled.
func (l *Library) ChooseOutputDir(ctx context.Context) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:            mygo.CallerWindow(ctx),
		Title:             "选择保存目录",
		ButtonLabel:       "选择",
		Directory:         true,
		CreateDirectories: true,
	})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// target is one output file the batch will write.
type target struct {
	info imageinfo.Info
	dir  string
	name string
	err  error
}

// targets resolves the folder and a reserved file name for each request, in
// order. The images being written reserve names per folder, so two same-stem
// images never share one, and the sheet shows what Save writes.
func (l *Library) targets(reqs []NameRequest, quality naming.Quality, inPlace bool, outDir string) []target {
	l.mu.Lock()
	defer l.mu.Unlock()
	taken := make(map[string]map[string]bool)
	out := make([]target, 0, len(reqs))
	for _, req := range reqs {
		e, ok := l.entries[req.ID]
		if !ok {
			out = append(out, target{err: errors.New("图片已不在列表中")})
			continue
		}
		stem, ext := naming.Split(e.info.Name)
		name := naming.Name(stem, ext, req.Ratio, e.info.Format, quality, l.stamp)
		dir := outDir
		if inPlace {
			dir = filepath.Dir(e.info.Path)
		}
		if dir == "" {
			out = append(out, target{info: e.info, name: name, err: errors.New("未指定输出目录")})
			continue
		}
		// An image that stays behind shows its name but holds no reservation.
		var reserved map[string]bool
		if req.Applied {
			reserved = taken[dir]
			if reserved == nil {
				reserved = make(map[string]bool)
				taken[dir] = reserved
			}
		}
		unique, err := naming.Reserve(dir, name, reserved)
		if err != nil {
			out = append(out, target{info: e.info, dir: dir, name: name, err: err})
			continue
		}
		out = append(out, target{info: e.info, dir: dir, name: unique})
	}
	return out
}

// PreviewNames returns the output file names of items, in order, so the page
// shows exactly what Save writes, including the -2 suffix of a name that
// already exists in the target folder or earlier in the batch.
func (l *Library) PreviewNames(items []NameRequest, quality string, inPlace bool, outDir string) []string {
	plan := l.targets(items, naming.ParseQuality(quality), inPlace, outDir)
	names := make([]string, 0, len(plan))
	for _, t := range plan {
		names = append(names, t.name)
	}
	return names
}

// Save writes every item and reports progress as it goes. Closing the channel
// from the page cancels the run: written files stay, the rest are skipped.
func (l *Library) Save(ctx context.Context, req SaveRequest, progress *mygo.Channel[Progress]) (Report, error) {
	var send func(Progress) error
	if progress != nil {
		send = progress.Send
	}
	return l.save(ctx, req, send)
}

// save is Save with the channel replaced by a function, so tests can record
// the events without a page.
func (l *Library) save(ctx context.Context, req SaveRequest, send func(Progress) error) (Report, error) {
	quality := naming.ParseQuality(req.Quality)
	reqs := make([]NameRequest, 0, len(req.Items))
	for _, item := range req.Items {
		reqs = append(reqs, NameRequest{ID: item.ID, Ratio: item.Ratio, Applied: true})
	}
	// Names are planned for the whole batch before the first file is written:
	// a file that fails keeps its name, so the sheet stays true.
	plan := l.targets(reqs, quality, req.InPlace, req.OutDir)

	report := Report{Saved: []string{}, Failed: []Failure{}}
	if !req.InPlace {
		report.Dir = req.OutDir
	}
	total := len(req.Items)
	for i, item := range req.Items {
		if ctx.Err() != nil {
			report.Canceled = true
			return report, nil
		}
		t := plan[i]
		name := t.info.Name
		if name == "" {
			name = item.ID
		}
		var written string
		err := t.err
		if err == nil {
			written, err = writeTarget(t, item, quality)
		}
		if err != nil {
			report.Failed = append(report.Failed, Failure{Name: name, Error: err.Error()})
		} else {
			report.Saved = append(report.Saved, written)
		}
		if send != nil {
			p := Progress{Done: i + 1, Total: total, OK: err == nil}
			if err != nil {
				p.Error = err.Error()
			}
			if err := send(p); err != nil {
				report.Canceled = true
				return report, nil
			}
		}
	}
	return report, nil
}

// writeTarget crops and encodes one planned output.
func writeTarget(t target, item SaveItem, quality naming.Quality) (string, error) {
	if err := os.MkdirAll(t.dir, 0o755); err != nil {
		return "", err
	}
	out := filepath.Join(t.dir, t.name)
	rect := crop.PixelRect(t.info.Width, t.info.Height, crop.Norm{X: item.Crop.X, Y: item.Crop.Y, W: item.Crop.W, H: item.Crop.H})
	if err := saver.Save(saver.Request{Source: t.info.Path, Output: out, Rect: rect, Format: t.info.Format}, quality); err != nil {
		return "", err
	}
	return out, nil
}

// ShowInFolder reveals path in Finder, Explorer or the file manager.
func (l *Library) ShowInFolder(path string) {
	if path == "" {
		return
	}
	mygo.Shell.ShowItemInFolder(path)
}

func (l *Library) importPaths(paths []string) ImportResult {
	result := ImportResult{Images: []Image{}}
	for _, path := range paths {
		img, err := l.add(path)
		if err != nil {
			result.Skipped++
			continue
		}
		result.Images = append(result.Images, img)
	}
	return result
}

func (l *Library) add(path string) (Image, error) {
	info, decoded, err := imageinfo.Load(path)
	if err != nil {
		return Image{}, err
	}
	thumb, err := imageinfo.Thumbnail(decoded, 96)
	if err != nil {
		return Image{}, err
	}
	id := newID()
	l.mu.Lock()
	l.entries[id] = entry{info: info}
	l.thumbs[id] = thumb
	l.mu.Unlock()
	return Image{
		ID:      id,
		Name:    info.Name,
		Width:   info.Width,
		Height:  info.Height,
		Bytes:   info.Bytes,
		Format:  string(info.Format),
		Thumb:   assetURL("thumb", id),
		Preview: assetURL("img", id),
	}, nil
}

// newID is an opaque name for one imported image.
func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// assetURL addresses an app protocol the way the platform's webview does.
func assetURL(scheme, id string) string {
	if runtime.GOOS == "windows" {
		return "http://" + scheme + ".localhost/" + id
	}
	return scheme + "://localhost/" + id
}

func (l *Library) serveImage(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/")
	l.mu.Lock()
	e, ok := l.entries[id]
	l.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, e.info.Path)
}

func (l *Library) serveThumb(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/")
	l.mu.Lock()
	data, ok := l.thumbs[id]
	l.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "max-age=31536000, immutable")
	_, _ = w.Write(data)
}

func main() {
	lib := newLibrary()
	mygo.Bind(lib)
	mygo.Theme.SetSource(mygo.ThemeDark)

	mygo.App.WhenReady(func() {
		dataDir, err := mygo.App.Path(mygo.PathUserData)
		if err != nil {
			log.Fatal(err)
		}
		lib.dataDir = dataDir
		lib.loadSettings()

		if err := mygo.Protocol.HandleFunc("img", lib.serveImage); err != nil {
			log.Fatal(err)
		}
		if err := mygo.Protocol.HandleFunc("thumb", lib.serveThumb); err != nil {
			log.Fatal(err)
		}

		mygo.NewWindow(mygo.WindowOptions{
			Title:           "PictureCut",
			URL:             "/",
			Width:           1200,
			Height:          780,
			MinWidth:        960,
			MinHeight:       600,
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  52,
			BackgroundColor: "#161412",
			StateKey:        "main",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

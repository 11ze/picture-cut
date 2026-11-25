package main

import (
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"picturecut/internal/naming"
)

// writeImage writes a small picture with a recognizable gradient.
func writeImage(t *testing.T, path string, w, h int, format string) {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			m.SetNRGBA(x, y, color.NRGBA{R: uint8(x % 256), G: uint8(y % 256), B: 120, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if format == "png" {
		err = png.Encode(f, m)
	} else {
		err = jpeg.Encode(f, m, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func newTestLibrary(t *testing.T) *Library {
	t.Helper()
	lib := newLibrary()
	lib.dataDir = t.TempDir()
	lib.loadSettings()
	return lib
}

func TestImportPreviewAndSave(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	jpg := filepath.Join(src, "city.jpg")
	pngPath := filepath.Join(src, "lake.png")
	writeImage(t, jpg, 400, 300, "jpeg")
	writeImage(t, pngPath, 300, 400, "png")
	notes := filepath.Join(src, "notes.txt")
	if err := os.WriteFile(notes, []byte("not a picture"), 0o644); err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(src, "broken.jpg")
	if err := os.WriteFile(broken, []byte("not a jpeg either"), 0o644); err != nil {
		t.Fatal(err)
	}

	lib := newTestLibrary(t)
	result := lib.importPaths([]string{jpg, pngPath, notes, broken})
	if len(result.Images) != 2 {
		t.Fatalf("images = %d, want 2", len(result.Images))
	}
	if result.Skipped != 2 {
		t.Fatalf("skipped = %d, want 2", result.Skipped)
	}
	city, lake := result.Images[0], result.Images[1]
	if city.Name != "city.jpg" || city.Width != 400 || city.Height != 300 || city.Format != "JPEG" {
		t.Fatalf("city = %+v", city)
	}
	if lake.Format != "PNG" {
		t.Fatalf("lake format = %q", lake.Format)
	}
	if !strings.HasPrefix(city.Preview, "img://") || !strings.HasPrefix(city.Thumb, "thumb://") {
		t.Fatalf("asset urls = %q, %q", city.Preview, city.Thumb)
	}

	stamp := lib.stamp
	names := lib.PreviewNames(
		[]NameRequest{{ID: city.ID, Ratio: "16:9"}, {ID: lake.ID, Ratio: "1:1"}},
		string(naming.Compressed), false, dir,
	)
	wantJPG := "city_16x9_q80_" + stamp + ".jpg"
	wantPNG := "lake_1x1_compressed_" + stamp + ".png"
	if names[0] != wantJPG || names[1] != wantPNG {
		t.Fatalf("names = %v, want [%s %s]", names, wantJPG, wantPNG)
	}

	out := filepath.Join(dir, "out")
	items := []SaveItem{
		{ID: city.ID, Ratio: "16:9", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
		{ID: lake.ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0.125, W: 1, H: 0.75}},
	}
	report, err := lib.Save(context.Background(), SaveRequest{
		Items: items, Quality: "compressed", OutDir: out,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Failed) != 0 || len(report.Saved) != 2 {
		t.Fatalf("report = %+v", report)
	}
	if report.Dir != out {
		t.Fatalf("dir = %q, want %q", report.Dir, out)
	}

	check := func(name string, w, h int) {
		t.Helper()
		path := filepath.Join(out, name)
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		m, _, err := image.Decode(f)
		if err != nil {
			t.Fatal(err)
		}
		if b := m.Bounds(); b.Dx() != w || b.Dy() != h {
			t.Fatalf("%s is %dx%d, want %dx%d", name, b.Dx(), b.Dy(), w, h)
		}
	}
	check(wantJPG, 400, 300)
	check(wantPNG, 300, 300)

	// A second run must not overwrite the first: names get -2, and the sheet
	// announces those names.
	again := lib.PreviewNames([]NameRequest{{ID: city.ID, Ratio: "16:9"}}, string(naming.Compressed), false, out)
	if own := "city_16x9_q80_" + stamp + "-2.jpg"; again[0] != own {
		t.Fatalf("collision name = %q, want %q", again[0], own)
	}
	second, err := lib.Save(context.Background(), SaveRequest{
		Items: items[:1], Quality: "compressed", OutDir: out,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Saved) != 1 || filepath.Base(second.Saved[0]) != "city_16x9_q80_"+stamp+"-2.jpg" {
		t.Fatalf("second save = %+v", second)
	}
}

func TestSaveInPlaceAndFailures(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(src, "good.jpg")
	lost := filepath.Join(src, "lost.jpg")
	writeImage(t, good, 200, 200, "jpeg")
	writeImage(t, lost, 200, 200, "jpeg")

	lib := newTestLibrary(t)
	imported := lib.importPaths([]string{good, lost})
	if len(imported.Images) != 2 {
		t.Fatalf("images = %d", len(imported.Images))
	}
	if err := os.Remove(lost); err != nil {
		t.Fatal(err)
	}

	report, err := lib.Save(context.Background(), SaveRequest{
		Items: []SaveItem{
			{ID: imported.Images[0].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
			{ID: imported.Images[1].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
		},
		Quality: "high",
		InPlace: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Dir != "" {
		t.Fatalf("dir = %q, want empty for in-place", report.Dir)
	}
	if len(report.Saved) != 1 || filepath.Dir(report.Saved[0]) != src {
		t.Fatalf("saved = %v", report.Saved)
	}
	if len(report.Failed) != 1 || report.Failed[0].Name != "lost.jpg" {
		t.Fatalf("failed = %+v", report.Failed)
	}
}

func TestSaveCanceledWritesNothing(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "city.jpg")
	writeImage(t, src, 120, 90, "jpeg")

	lib := newTestLibrary(t)
	imported := lib.importPaths([]string{src})
	if len(imported.Images) != 1 {
		t.Fatalf("images = %d", len(imported.Images))
	}
	out := filepath.Join(dir, "out")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := lib.Save(ctx, SaveRequest{
		Items:  []SaveItem{{ID: imported.Images[0].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}}},
		OutDir: out,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Canceled || len(report.Saved) != 0 {
		t.Fatalf("report = %+v", report)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatalf("output folder was created: %v", err)
	}
}

func TestCollectImagesSkipsHiddenFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeImage(t, filepath.Join(dir, "keep.jpg"), 40, 40, "jpeg")
	writeImage(t, filepath.Join(dir, "keep.png"), 40, 40, "png")
	writeImage(t, filepath.Join(dir, ".hidden.png"), 40, 40, "png")
	writeImage(t, filepath.Join(dir, ".git", "inner.jpg"), 40, 40, "jpeg")
	if err := os.WriteFile(filepath.Join(dir, "readme.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := collectImages(dir)
	want := []string{filepath.Join(dir, "keep.jpg"), filepath.Join(dir, "keep.png")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("collectImages = %v, want %v", got, want)
	}
}

func TestImportPathsTakesFilesAndFolders(t *testing.T) {
	dir := t.TempDir()
	folder := filepath.Join(dir, "trip")
	if err := os.MkdirAll(filepath.Join(folder, "nested", ".cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeImage(t, filepath.Join(dir, "one.jpg"), 40, 30, "jpeg")
	writeImage(t, filepath.Join(folder, "two.png"), 40, 30, "png")
	writeImage(t, filepath.Join(folder, "nested", "three.jpeg"), 40, 30, "jpeg")
	writeImage(t, filepath.Join(folder, ".hidden.png"), 40, 30, "png")
	writeImage(t, filepath.Join(folder, "nested", ".cache", "four.png"), 40, 30, "png")
	if err := os.WriteFile(filepath.Join(folder, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "gone.jpg")

	lib := newTestLibrary(t)
	got := lib.ImportPaths([]string{filepath.Join(dir, "one.jpg"), folder, missing})

	names := make([]string, len(got.Images))
	for i, img := range got.Images {
		names[i] = img.Name
	}
	sort.Strings(names)
	want := []string{"one.jpg", "three.jpeg", "two.png"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("images = %v, want %v", names, want)
	}
	if got.Skipped != 1 {
		t.Fatalf("skipped = %d, want 1", got.Skipped)
	}
}

func TestImportPathsFolderWithoutImages(t *testing.T) {
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	lib := newTestLibrary(t)
	got := lib.ImportPaths([]string{folder})
	if len(got.Images) != 0 || got.Skipped != 0 {
		t.Fatalf("import = %d images, %d skipped, want none", len(got.Images), got.Skipped)
	}
}

func TestProtocolServesImportedImages(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "city.jpg")
	writeImage(t, src, 400, 300, "jpeg")

	lib := newTestLibrary(t)
	imported := lib.importPaths([]string{src})
	id := imported.Images[0].ID

	rec := httptest.NewRecorder()
	lib.serveImage(rec, httptest.NewRequest(http.MethodGet, "/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/jpeg") {
		t.Fatalf("content type = %q", ct)
	}
	if _, _, err := image.Decode(rec.Body); err != nil {
		t.Fatalf("body is not a picture: %v", err)
	}

	rec = httptest.NewRecorder()
	lib.serveThumb(rec, httptest.NewRequest(http.MethodGet, "/"+id, nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/jpeg" || rec.Body.Len() == 0 {
		t.Fatalf("thumb status=%d type=%q len=%d", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
	}

	rec = httptest.NewRecorder()
	lib.serveImage(rec, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing id status = %d", rec.Code)
	}
}

func TestPreviewNamesReserveWithinBatch(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	writeImage(t, src, 80, 60, "jpeg")

	lib := newTestLibrary(t)
	first := lib.importPaths([]string{src}).Images[0]
	second := lib.importPaths([]string{src}).Images[0]
	out := filepath.Join(dir, "out")
	base := "photo_1x1_q80_" + lib.stamp + ".jpg"

	names := lib.PreviewNames([]NameRequest{
		{ID: first.ID, Ratio: "1:1", Applied: true},
		{ID: second.ID, Ratio: "1:1", Applied: true},
	}, "compressed", false, out)
	if len(names) != 2 || names[0] != base || names[1] != "photo_1x1_q80_"+lib.stamp+"-2.jpg" {
		t.Fatalf("names = %v", names)
	}

	report, err := lib.save(context.Background(), SaveRequest{
		Items: []SaveItem{
			{ID: first.ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
			{ID: second.ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
		},
		Quality: "compressed",
		OutDir:  out,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Saved) != 2 {
		t.Fatalf("saved = %v", report.Saved)
	}
	for i, path := range report.Saved {
		if filepath.Base(path) != names[i] {
			t.Fatalf("wrote %q, sheet showed %q", filepath.Base(path), names[i])
		}
	}
}

func TestPreviewNamesExcludedDoesNotReserve(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	writeImage(t, src, 80, 60, "jpeg")

	lib := newTestLibrary(t)
	hidden := lib.importPaths([]string{src}).Images[0]
	shown := lib.importPaths([]string{src}).Images[0]
	out := filepath.Join(dir, "out")
	base := "photo_1x1_q80_" + lib.stamp + ".jpg"

	names := lib.PreviewNames([]NameRequest{
		{ID: hidden.ID, Ratio: "1:1", Applied: false},
		{ID: shown.ID, Ratio: "1:1", Applied: true},
	}, "compressed", false, out)
	if names[0] != base || names[1] != base {
		t.Fatalf("excluded image reserved a name: %v", names)
	}
}

func TestSaveReportsProgressForEveryItem(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.jpg")
	lost := filepath.Join(dir, "lost.jpg")
	writeImage(t, good, 40, 40, "jpeg")
	writeImage(t, lost, 40, 40, "jpeg")

	lib := newTestLibrary(t)
	imported := lib.importPaths([]string{good, lost})
	if err := os.Remove(lost); err != nil {
		t.Fatal(err)
	}

	var events []Progress
	report, err := lib.save(context.Background(), SaveRequest{
		Items: []SaveItem{
			{ID: imported.Images[0].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
			{ID: imported.Images[1].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
		},
		OutDir: filepath.Join(dir, "out"),
	}, func(p Progress) error {
		events = append(events, p)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %+v, want one per item", events)
	}
	if !events[0].OK || events[0].Done != 1 || events[0].Total != 2 || events[0].Error != "" {
		t.Fatalf("first event = %+v", events[0])
	}
	if events[1].OK || events[1].Done != 2 || events[1].Error == "" {
		t.Fatalf("second event = %+v", events[1])
	}
	if len(report.Saved) != 1 || len(report.Failed) != 1 || report.Failed[0].Name != "lost.jpg" {
		t.Fatalf("report = %+v", report)
	}
}

func TestSaveStopsWhenThePageClosesTheChannel(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	writeImage(t, src, 40, 40, "jpeg")
	lib := newTestLibrary(t)
	imported := lib.importPaths([]string{src})

	report, err := lib.save(context.Background(), SaveRequest{
		Items:  []SaveItem{{ID: imported.Images[0].ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}}},
		OutDir: filepath.Join(dir, "out"),
	}, func(Progress) error {
		return mygo.ErrChannelClosed
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Canceled || len(report.Saved) != 1 {
		t.Fatalf("report = %+v", report)
	}
}

func TestUpdateSettingsPersists(t *testing.T) {
	lib := newTestLibrary(t)
	want := SettingsModel{InPlace: false, OutDir: filepath.Join(lib.dataDir, "picks"), Quality: "high"}
	if err := lib.UpdateSettings(want); err != nil {
		t.Fatal(err)
	}

	again := newLibrary()
	again.dataDir = lib.dataDir
	again.loadSettings()
	if got := again.Settings(); got != want {
		t.Fatalf("settings = %+v, want %+v", got, want)
	}
}

func TestSaveWritesTheNamesTheSheetShows(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "a")
	second := filepath.Join(dir, "b")
	for _, d := range []string{first, second} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	gone := filepath.Join(first, "city.jpg")
	kept := filepath.Join(second, "city.jpg")
	writeImage(t, gone, 80, 60, "jpeg")
	writeImage(t, kept, 80, 60, "jpeg")

	lib := newTestLibrary(t)
	a := lib.importPaths([]string{gone}).Images[0]
	b := lib.importPaths([]string{kept}).Images[0]
	out := filepath.Join(dir, "out")
	items := []SaveItem{
		{ID: a.ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
		{ID: b.ID, Ratio: "1:1", Crop: Crop{X: 0, Y: 0, W: 1, H: 1}},
	}
	names := lib.PreviewNames([]NameRequest{
		{ID: a.ID, Ratio: "1:1", Applied: true},
		{ID: b.ID, Ratio: "1:1", Applied: true},
	}, "compressed", false, out)
	if len(names) != 2 || names[0] == names[1] {
		t.Fatalf("preview = %v, want two different names", names)
	}

	// The first source disappears after the sheet showed both names.
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	report, err := lib.save(context.Background(), SaveRequest{
		Items: items, Quality: "compressed", OutDir: out,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Failed) != 1 || len(report.Saved) != 1 {
		t.Fatalf("report = %+v", report)
	}
	if got := filepath.Base(report.Saved[0]); got != names[1] {
		t.Fatalf("wrote %q, the sheet showed %q", got, names[1])
	}
}

func TestSaveKeepsFileCreatedAfterBatchPlanning(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.png")
	writeImage(t, src, 20, 10, "png")
	lib := newTestLibrary(t)
	img := lib.ImportPaths([]string{src}).Images[0]
	item := SaveItem{ID: img.ID, Ratio: "1:1", Crop: Crop{W: 1, H: 1}}
	base := "photo_1x1_" + lib.stamp
	occupied := filepath.Join(dir, base+"-2.png")
	report, err := lib.save(context.Background(), SaveRequest{Items: []SaveItem{item, item}, Quality: "high", InPlace: true}, func(p Progress) error {
		if p.Done == 1 {
			return os.WriteFile(occupied, []byte("another task"), 0644)
		}
		return nil
	})
	data, readErr := os.ReadFile(occupied)
	if err != nil || readErr != nil || string(data) != "another task" || len(report.Saved) != 2 || filepath.Base(report.Saved[1]) != base+"-3.png" {
		t.Fatalf("existing output preserved = %v, report = %+v, errors = %v, %v", string(data) == "another task", report, err, readErr)
	}
}

func TestReleaseImagesDropsPreviewAndThumbnailButKeepsSource(t *testing.T) {
	lib := newTestLibrary(t)
	path := filepath.Join(t.TempDir(), "photo.png")
	writeImage(t, path, 12, 10, "png")
	images := lib.ImportPaths([]string{path, path}).Images
	lib.ReleaseImages([]string{images[0].ID})
	for i, img := range images {
		for _, serve := range []http.HandlerFunc{lib.serveImage, lib.serveThumb} {
			rec := httptest.NewRecorder()
			serve(rec, httptest.NewRequest("GET", "/"+img.ID, nil))
			want := http.StatusOK
			if i == 0 {
				want = http.StatusNotFound
			}
			if rec.Code != want {
				t.Fatalf("image %d: status %d, want %d", i, rec.Code, want)
			}
		}
	}
}

func TestConcurrentSavesKeepBothCrops(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.png")
	writeImage(t, src, 20, 10, "png")
	lib := newTestLibrary(t)
	img := lib.ImportPaths([]string{src}).Images[0]
	start := make(chan struct{})
	type outcome struct {
		report Report
		err    error
		width  int
	}
	results := make(chan outcome, 2)
	for _, width := range []int{10, 20} {
		go func() {
			<-start
			item := SaveItem{ID: img.ID, Ratio: "1:1", Crop: Crop{W: float64(width) / 20, H: 1}}
			report, err := lib.Save(context.Background(), SaveRequest{Items: []SaveItem{item}, InPlace: true, Quality: "high"}, nil)
			results <- outcome{report, err, width}
		}()
	}
	close(start)
	first, second := <-results, <-results
	for _, result := range []outcome{first, second} {
		if result.err != nil || len(result.report.Saved) != 1 {
			t.Fatalf("save: %+v", result)
		}
		f, err := os.Open(result.report.Saved[0])
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := png.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width != result.width {
			t.Fatalf("crop width %d, want %d; err %v", cfg.Width, result.width, err)
		}
	}
}

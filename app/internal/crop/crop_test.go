package crop

import (
	"encoding/json"
	"os"
	"testing"
)

// PixelRect must agree with the page's crop.ts, so both read the same table.
// The cases come from the design: the page shows the pixel size it will export.
func TestPixelRect(t *testing.T) {
	data, err := os.ReadFile("../../testdata/crop-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name       string
		ImgW, ImgH int
		X, Y, W, H float64
		Want       Rect
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := PixelRect(c.ImgW, c.ImgH, Norm{X: c.X, Y: c.Y, W: c.W, H: c.H})
			if got != c.Want {
				t.Errorf("PixelRect(%d×%d, %+v) = %+v, want %+v", c.ImgW, c.ImgH, Norm{c.X, c.Y, c.W, c.H}, got, c.Want)
			}
		})
	}
}

func TestPixelRectRejectsEmptyImages(t *testing.T) {
	for _, c := range []struct{ w, h int }{{0, 100}, {100, 0}, {-5, -5}} {
		if got := PixelRect(c.w, c.h, Norm{W: 1, H: 1}); got != (Rect{}) {
			t.Errorf("PixelRect(%d×%d) = %+v, want zero", c.w, c.h, got)
		}
	}
}

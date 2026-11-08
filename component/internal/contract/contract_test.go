package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// desiredText is what the app's serializeDesired writes: compact JSON plus a newline.
const desiredText = `{"schema":1,"mode":"mirror","collections":[{"name":"Giallo","members":["Gialli/Uno.azw3","Due.pdf"]},{"name":"Vuota","members":[]}]}` + "\n"

func readyFor(text string) []byte {
	sum := sha256.Sum256([]byte(text))
	return []byte(hex.EncodeToString(sum[:]) + "\n")
}

func TestParseDesiredAcceptsAFileMarkedReady(t *testing.T) {
	desired, hash, err := ParseDesired([]byte(desiredText), readyFor(desiredText))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desired.Mode != ModeMirror {
		t.Errorf("mode = %q, want mirror", desired.Mode)
	}
	if len(desired.Collections) != 2 || desired.Collections[0].Name != "Giallo" || len(desired.Collections[0].Members) != 2 {
		t.Errorf("collections = %+v", desired.Collections)
	}
	if len(desired.Collections[1].Members) != 0 {
		t.Errorf("an empty collection must stay listed, empty: %+v", desired.Collections[1])
	}
	if want := strings.TrimSpace(string(readyFor(desiredText))); hash != want {
		t.Errorf("hash = %s, want %s (the value the app compares appliedDesired with)", hash, want)
	}
}

func TestParseDesiredAcceptsHoldMode(t *testing.T) {
	text := `{"schema":1,"mode":"hold","collections":[]}` + "\n"

	desired, _, err := ParseDesired([]byte(text), readyFor(text))

	if err != nil || desired.Mode != ModeHold {
		t.Fatalf("got %+v, %v", desired, err)
	}
}

func TestParseDesiredRefusesAFileNotMarkedReady(t *testing.T) {
	cases := []struct {
		name  string
		text  string
		ready []byte
	}{
		{"no marker", desiredText, nil},
		{"marker of another file", desiredText, readyFor(`{"schema":1,"mode":"hold","collections":[]}`)},
		{"half-written file", desiredText[:40], readyFor(desiredText)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ParseDesired([]byte(tc.text), tc.ready)
			if !errors.Is(err, ErrNotReady) {
				t.Errorf("err = %v, want ErrNotReady", err)
			}
		})
	}
}

func TestParseDesiredRefusesAnythingOffSchema(t *testing.T) {
	cases := map[string]string{
		"other schema":         `{"schema":2,"mode":"mirror","collections":[]}`,
		"unknown mode":         `{"schema":1,"mode":"wipe","collections":[]}`,
		"no collections":       `{"schema":1,"mode":"mirror"}`,
		"blank name":           `{"schema":1,"mode":"mirror","collections":[{"name":"  ","members":[]}]}`,
		"absolute member":      `{"schema":1,"mode":"mirror","collections":[{"name":"A","members":["/etc/passwd"]}]}`,
		"member leaving docs":  `{"schema":1,"mode":"mirror","collections":[{"name":"A","members":["../system/x.azw3"]}]}`,
		"drive letter member":  `{"schema":1,"mode":"mirror","collections":[{"name":"A","members":["C:/x.azw3"]}]}`,
		"not json":             `{"schema":1,`,
		"collections not list": `{"schema":1,"mode":"mirror","collections":{}}`,
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ParseDesired([]byte(text), readyFor(text)); err == nil {
				t.Errorf("accepted %s", text)
			}
		})
	}
}

func TestParseDesiredRefusesMoreCollectionsThanAKindleHolds(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"schema":1,"mode":"mirror","collections":[`)
	for i := 0; i <= MaxCollections; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"name":"C","members":[]}`)
	}
	b.WriteString("]}")
	text := b.String()

	if _, _, err := ParseDesired([]byte(text), readyFor(text)); err == nil {
		t.Error("accepted more than MaxCollections collections")
	}
}

func TestIsDocumentsRelpath(t *testing.T) {
	for relpath, want := range map[string]bool{
		"Dune.azw3":         true,
		"Herbert/Dune.azw3": true,
		"":                  false,
		"/Dune.azw3":        false,
		"c:/Dune.azw3":      false,
		"A/../../Dune.azw3": false,
		"..":                false,
	} {
		if got := IsDocumentsRelpath(relpath); got != want {
			t.Errorf("IsDocumentsRelpath(%q) = %v, want %v", relpath, got, want)
		}
	}
}

func TestFoldMatchesComposedAndDecomposedNamesIgnoringCase(t *testing.T) {
	if Fold("Citta\u0300/Libro.AZW3") != Fold("città/libro.azw3") {
		t.Error("a decomposed, upper-case name must fold like the composed lower-case one")
	}
}

func TestStatusJSONMatchesWhatTheAppValidates(t *testing.T) {
	status := NewStatus("kt5-ab12", "1.0.0")
	status.FinishedAt = "2026-11-08T10:00:00Z"
	status.Result = ResultOK

	raw, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}

	if got["schema"] != float64(1) || got["deviceId"] != "kt5-ab12" || got["componentVersion"] != "1.0.0" {
		t.Errorf("identity fields: %s", raw)
	}
	if v, ok := got["appliedDesired"]; !ok || v != nil {
		t.Errorf("appliedDesired must be present and null: %s", raw)
	}
	if v, ok := got["pendingBooks"].([]any); !ok || len(v) != 0 {
		t.Errorf("pendingBooks must be an empty list, not null: %s", raw)
	}
	if _, ok := got["error"]; ok {
		t.Errorf("error must be omitted when there is none: %s", raw)
	}
}

func TestStatusErrorIsCappedForTheApp(t *testing.T) {
	status := NewStatus("kt5", "1.0.0").WithError(errors.New(strings.Repeat("é", 2*MaxErrorRunes)))

	if n := len([]rune(status.Error)); n != MaxErrorRunes {
		t.Errorf("error has %d runes, want %d", n, MaxErrorRunes)
	}
	if status.Result != ResultError || status.AppliedDesired != nil {
		t.Errorf("an error status reports result error and nothing applied: %+v", status)
	}
}

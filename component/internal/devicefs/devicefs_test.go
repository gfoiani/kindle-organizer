package devicefs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
)

func TestReadDesiredReturnsTheFileAndItsMarker(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	mustWrite(t, filepath.Join(dir.Root, "desired.json"), "{}\n")
	mustWrite(t, filepath.Join(dir.Root, "desired.ready"), "abc\n")

	text, ready, err := dir.ReadDesired()

	if err != nil || string(text) != "{}\n" || string(ready) != "abc\n" {
		t.Errorf("got %q, %q, %v", text, ready, err)
	}
}

func TestReadDesiredWithoutAMarkerReturnsNoMarker(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	mustWrite(t, filepath.Join(dir.Root, "desired.json"), "{}\n")

	_, ready, err := dir.ReadDesired()

	if err != nil || ready != nil {
		t.Errorf("ready = %q, err = %v: a missing marker is for ParseDesired to refuse", ready, err)
	}
}

func TestReadDesiredReportsThatThereIsNone(t *testing.T) {
	_, _, err := Dir{Root: t.TempDir()}.ReadDesired()

	if !errors.Is(err, ErrNoDesired) {
		t.Errorf("err = %v, want ErrNoDesired", err)
	}
}

func TestReadDesiredRefusesAnOversizedFile(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	mustWrite(t, filepath.Join(dir.Root, "desired.json"), strings.Repeat(" ", MaxDesiredBytes+1))

	if _, _, err := dir.ReadDesired(); err == nil {
		t.Error("an oversized desired.json must be refused")
	}
}

func TestWriteStatusReplacesTheFileWholeAndLeavesNoTemp(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	mustWrite(t, filepath.Join(dir.Root, "status.json"), "old")
	status := contract.NewStatus("kt5", "1.0.0")

	if err := dir.WriteStatus(status); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir.Root, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var back contract.Status
	if err := json.Unmarshal(raw, &back); err != nil || back.DeviceID != "kt5" || !strings.HasSuffix(string(raw), "\n") {
		t.Errorf("status.json = %s (%v)", raw, err)
	}
	assertNoTemp(t, dir.Root)
}

func TestWriteExportCreatesTheFolderWhenMissing(t *testing.T) {
	dir := Dir{Root: filepath.Join(t.TempDir(), "kindle-organizer")}

	err := dir.WriteExport(contract.Export{Schema: 1, Collections: []contract.ExportCollection{}})

	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir.Root, "export.json"))
	if err != nil || string(raw) != "{\"schema\":1,\"collections\":[]}\n" {
		t.Errorf("export.json = %q, %v", raw, err)
	}
	assertNoTemp(t, dir.Root)
}

func TestDeviceIDIsCreatedOnceAndKept(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", "device-id")
	calls := 0
	newID := func() string { calls++; return "kt5-0001" }

	first, err := LoadOrCreateDeviceID(file, newID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreateDeviceID(file, newID)
	if err != nil {
		t.Fatal(err)
	}

	if first != "kt5-0001" || second != first || calls != 1 {
		t.Errorf("first %q, second %q, %d ids generated", first, second, calls)
	}
}

func TestDeviceIDReplacesAnUnusableStoredValue(t *testing.T) {
	file := filepath.Join(t.TempDir(), "device-id")
	mustWrite(t, file, "not a valid id!\n")

	id, err := LoadOrCreateDeviceID(file, func() string { return "fresh-id" })

	if err != nil || id != "fresh-id" {
		t.Errorf("id = %q, %v", id, err)
	}
}

func TestWriteFailsWhenTheFolderCannotBeMade(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "kindle-organizer")
	mustWrite(t, blocker, "a file where the folder should be")

	if err := (Dir{Root: blocker}).WriteStatus(contract.NewStatus("kt5", "1.0.0")); err == nil {
		t.Error("expected an error")
	}
}

func TestAFailedWriteLeavesThePreviousFileUntouched(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	mustWrite(t, filepath.Join(dir.Root, "status.json"), "previous")
	// A folder where the temp file goes makes the write fail before the rename.
	if err := os.Mkdir(filepath.Join(dir.Root, "status.json.tmp"), 0o755); err != nil {
		t.Fatal(err)
	}

	err := dir.WriteStatus(contract.NewStatus("kt5", "1.0.0"))

	raw, readErr := os.ReadFile(filepath.Join(dir.Root, "status.json"))
	if err == nil || readErr != nil || string(raw) != "previous" {
		t.Errorf("err = %v; status.json = %q (%v)", err, raw, readErr)
	}
}

func TestDeviceIDReportsAnUnreadableStore(t *testing.T) {
	file := filepath.Join(t.TempDir(), "device-id")
	if err := os.Mkdir(file, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadOrCreateDeviceID(file, func() string { return "x" }); err == nil {
		t.Error("a store that cannot be read must be an error, not a new id")
	}
}

func mustWrite(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertNoTemp(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", entry.Name())
		}
	}
}

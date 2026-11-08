package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The files in testdata/contract are shared with the app's
// test/kindleSyncContract.test.ts: desired.* as the app writes them, status and
// export as this component writes them. Both sides must agree on all four.
const fixtures = "../../testdata/contract"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAcceptsTheDesiredFileTheAppWrites(t *testing.T) {
	desired, hash, err := ParseDesired(fixture(t, "desired.json"), fixture(t, "desired.ready"))

	if err != nil {
		t.Fatal(err)
	}
	if desired.Mode != ModeMirror || len(desired.Collections) != 2 || desired.Collections[0].Members[1] != "Città/Due.pdf" {
		t.Errorf("desired = %+v", desired)
	}
	if hash != "aaecc450aac1825af3627c849d968e0e1842e56fc93477e1b8f817945448697f" {
		t.Errorf("hash = %s", hash)
	}
}

func TestWritesTheStatusFileTheAppReads(t *testing.T) {
	status := NewStatus("kt5-ab12", "0.1.0")
	status.FinishedAt = "2026-11-08T09:00:00Z"
	status.Result = ResultPartial
	status.Created, status.Updated = 1, 2
	status.PendingBooks = []string{"Nuovo.azw3"}
	applied := "aaecc450aac1825af3627c849d968e0e1842e56fc93477e1b8f817945448697f"
	status.AppliedDesired = &applied

	assertWrittenAs(t, status, "status.json")
}

func TestWritesTheExportFileTheAppReads(t *testing.T) {
	export := Export{Schema: SchemaVersion, Collections: []ExportCollection{
		{Name: "Giallo", Members: []string{"Gialli/Uno.azw3"}, OtherMembers: 2},
	}}

	assertWrittenAs(t, export, "export.json")
}

// assertWrittenAs checks value encodes byte for byte as the fixture (devicefs adds the newline).
func assertWrittenAs(t *testing.T, value any, name string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(raw)+"\n", string(fixture(t, name)); got != want {
		t.Errorf("%s:\n got %s\nwant %s", name, got, want)
	}
}

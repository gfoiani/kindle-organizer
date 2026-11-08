package library

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseHexRowsDecodesEveryFieldWhateverItHolds(t *testing.T) {
	// "A|B" and "line\nbreak" survive because sqlite3 prints them as hex.
	out := []byte("417C42|6C696E650A627265616B\n|43\n")

	rows, err := parseHexRows(out, 2)

	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"A|B", "line\nbreak"}, {"", "C"}}
	if !reflect.DeepEqual(rows, want) {
		t.Errorf("rows = %q, want %q", rows, want)
	}
}

func TestParseHexRowsRefusesWhatSqliteWouldNotPrint(t *testing.T) {
	for name, out := range map[string]string{
		"odd hex":          "4\n",
		"not hex":          "ZZ|41\n",
		"too few columns":  "41\n",
		"too many columns": "41|42|43\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseHexRows([]byte(out), 2); err == nil {
				t.Errorf("accepted %q", out)
			}
		})
	}
}

func TestParseHexRowsOfNothingIsNoRows(t *testing.T) {
	rows, err := parseHexRows(nil, 3)

	if err != nil || len(rows) != 0 {
		t.Errorf("rows = %v, err = %v", rows, err)
	}
}

func TestItemRelpathIsSetOnlyForBooksTheAppLists(t *testing.T) {
	cases := []struct {
		location string
		relpath  string
		ok       bool
	}{
		{"/mnt/us/documents/Herbert/Dune.azw3", "Herbert/Dune.azw3", true},
		{"/mnt/us/documents/Dune.AZW3", "Dune.AZW3", true},
		{"/mnt/us/documents/Notes.txt", "", false},
		{"/mnt/us/documents/../system/x.azw3", "", false},
		{"/mnt/us/other/Dune.azw3", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		relpath, ok := Item{Location: tc.location}.Relpath()
		if relpath != tc.relpath || ok != tc.ok {
			t.Errorf("Relpath(%q) = %q, %v; want %q, %v", tc.location, relpath, ok, tc.relpath, tc.ok)
		}
	}
}

// fixtureDB builds a cc.db-shaped database with the Mac's sqlite3 standing in
// for the device's. Only the columns the reader uses exist.
func fixtureDB(t *testing.T) string {
	t.Helper()
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 not installed")
	}
	db := filepath.Join(t.TempDir(), "cc.db")
	script := `
CREATE TABLE Entries (p_uuid TEXT, p_type TEXT, p_location TEXT, p_cdeKey TEXT, p_titles_0_nominal TEXT);
CREATE TABLE Collections (i_collection_uuid TEXT, i_member_uuid TEXT);
INSERT INTO Entries VALUES ('item-1', 'Entry:Item', '/mnt/us/documents/Dune.azw3', 'CDE1', 'Dune');
INSERT INTO Entries VALUES ('item-2', 'Entry:Item', NULL, 'B00AMAZON', 'Cloud book');
INSERT INTO Entries VALUES ('coll-1', 'Collection', NULL, NULL, 'Fantascienza | Classici' || char(10) || '🚀');
INSERT INTO Entries VALUES ('other', 'Entry:Dictionary', NULL, NULL, 'Dizionario');
INSERT INTO Collections VALUES ('coll-1', 'item-1');
INSERT INTO Collections VALUES ('coll-1', 'item-2');
`
	cmd := exec.Command(sqlite, db)
	cmd.Stdin = strings.NewReader(script)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the fixture: %v: %s", err, out)
	}
	return db
}

func TestReaderReadsItemsAndCollectionsFromASnapshot(t *testing.T) {
	db := fixtureDB(t)
	snapshot := filepath.Join(t.TempDir(), "snapshot.db")
	reader := Reader{SQLite: "sqlite3", LiveDB: db, SnapshotPath: snapshot, Run: ExecRunner}

	lib, err := reader.Read(context.Background())

	if err != nil {
		t.Fatal(err)
	}
	wantItems := []Item{
		{UUID: "item-1", Type: "Entry:Item", Location: "/mnt/us/documents/Dune.azw3", CdeKey: "CDE1"},
		{UUID: "item-2", Type: "Entry:Item", Location: "", CdeKey: "B00AMAZON"},
	}
	if !reflect.DeepEqual(lib.Items, wantItems) {
		t.Errorf("items = %+v", lib.Items)
	}
	wantCollections := []Collection{
		{UUID: "coll-1", Name: "Fantascienza | Classici\n🚀", Members: []string{"item-1", "item-2"}},
	}
	if !reflect.DeepEqual(lib.Collections, wantCollections) {
		t.Errorf("collections = %+v", lib.Collections)
	}
	if _, err := os.Stat(snapshot); !os.IsNotExist(err) {
		t.Errorf("the snapshot must be removed after reading (stat err = %v)", err)
	}
}

func TestReaderReportsAMissingDatabase(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not installed")
	}
	dir := t.TempDir()
	reader := Reader{SQLite: "sqlite3", LiveDB: filepath.Join(dir, "absent.db"), SnapshotPath: filepath.Join(dir, "s.db"), Run: ExecRunner}

	if _, err := reader.Read(context.Background()); err == nil {
		t.Error("reading a database that does not exist must fail, not return an empty library")
	}
}

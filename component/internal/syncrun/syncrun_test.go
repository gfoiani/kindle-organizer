package syncrun

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
	"github.com/gfoiani/kindle-organizer/component/internal/devicefs"
	"github.com/gfoiani/kindle-organizer/component/internal/library"
	"github.com/gfoiani/kindle-organizer/component/internal/plan"
)

func desiredFile(mode string, collections string) ([]byte, []byte) {
	text := []byte(`{"schema":1,"mode":"` + mode + `","collections":` + collections + `}` + "\n")
	return text, []byte(contract.Hash(text) + "\n")
}

func book(uuid, relpath string) library.Item {
	return library.Item{UUID: uuid, Type: library.ItemType, Location: library.DocumentsDir + relpath}
}

// harness records what a run does through fakes of every dependency.
type harness struct {
	desired, ready []byte
	desiredErr     error
	libraries      []library.Library // one per read; the last repeats
	readErr        error
	applyErr       error
	reads          int
	applied        []plan.Plan
	exports        []contract.Export
	statuses       []contract.Status
	sleeps         int
}

func (h *harness) deps() Deps {
	return Deps{
		ReadDesired: func() ([]byte, []byte, error) { return h.desired, h.ready, h.desiredErr },
		ReadLibrary: func(context.Context) (library.Library, error) {
			if h.readErr != nil {
				return library.Library{}, h.readErr
			}
			lib := h.libraries[min(h.reads, len(h.libraries)-1)]
			h.reads++
			return lib, nil
		},
		Apply: func(_ context.Context, p plan.Plan) error {
			h.applied = append(h.applied, p)
			return h.applyErr
		},
		WriteExport:   func(e contract.Export) error { h.exports = append(h.exports, e); return nil },
		WriteStatus:   func(s contract.Status) error { h.statuses = append(h.statuses, s); return nil },
		NewUUID:       func() string { return "new-uuid" },
		Now:           func() time.Time { return time.Date(2026, 11, 8, 10, 0, 0, 0, time.FixedZone("CET", 3600)) },
		Sleep:         func(time.Duration) { h.sleeps++ },
		DeviceID:      "kt5-ab12",
		Version:       "1.0.0",
		IndexWaits:    3,
		IndexInterval: time.Second,
	}
}

func TestMirrorAppliesTheCollectionsAndReportsWhatItApplied(t *testing.T) {
	h := &harness{libraries: []library.Library{
		{Items: []library.Item{book("b1", "Dune.azw3")}},
		{Items: []library.Item{book("b1", "Dune.azw3")}, Collections: []library.Collection{{UUID: "new-uuid", Name: "SF", Members: []string{"b1"}}}},
	}}
	h.desired, h.ready = desiredFile("mirror", `[{"name":"SF","members":["Dune.azw3"]}]`)

	status, err := Run(context.Background(), h.deps())

	if err != nil {
		t.Fatal(err)
	}
	if len(h.applied) != 1 || len(h.applied[0].Inserts) != 1 {
		t.Fatalf("applied = %+v", h.applied)
	}
	if status.Result != contract.ResultOK || status.Created != 1 || status.AppliedDesired == nil || *status.AppliedDesired != contract.Hash(h.desired) {
		t.Errorf("status = %+v", status)
	}
	if status.FinishedAt != "2026-11-08T09:00:00Z" || status.DeviceID != "kt5-ab12" || status.ComponentVersion != "1.0.0" {
		t.Errorf("identity/time: %+v", status)
	}
	if len(h.statuses) != 1 {
		t.Errorf("%d statuses written, want 1", len(h.statuses))
	}
	if last := h.exports[len(h.exports)-1]; len(last.Collections) != 1 || last.Collections[0].Name != "SF" {
		t.Errorf("the export after the run lists the Kindle's collections as they are now: %+v", last)
	}
}

func TestHoldChangesNothingButStillExportsTheKindlesCollections(t *testing.T) {
	h := &harness{libraries: []library.Library{{
		Items:       []library.Item{book("b1", "Dune.azw3")},
		Collections: []library.Collection{{UUID: "k1", Name: "Kindle", Members: []string{"b1"}}},
	}}}
	h.desired, h.ready = desiredFile("hold", `[]`)

	status, _ := Run(context.Background(), h.deps())

	if len(h.applied) != 0 {
		t.Errorf("hold applied %+v", h.applied)
	}
	if status.Result != contract.ResultOK || status.AppliedDesired != nil {
		t.Errorf("status = %+v", status)
	}
	if len(h.exports) == 0 || len(h.exports[0].Collections) != 1 {
		t.Errorf("the first-sync question needs the export: %+v", h.exports)
	}
}

func TestWithoutADesiredFileNothingIsApplied(t *testing.T) {
	h := &harness{libraries: []library.Library{{}}, desiredErr: devicefs.ErrNoDesired}

	status, _ := Run(context.Background(), h.deps())

	if len(h.applied) != 0 || status.Result != contract.ResultOK || status.AppliedDesired != nil {
		t.Errorf("applied %+v, status %+v", h.applied, status)
	}
}

func TestAFileNotMarkedReadyIsAnErrorAndNeverApplied(t *testing.T) {
	h := &harness{libraries: []library.Library{{}}}
	h.desired, _ = desiredFile("mirror", `[]`)
	h.ready = []byte("0000\n")

	status, _ := Run(context.Background(), h.deps())

	if len(h.applied) != 0 || status.Result != contract.ResultError || !strings.Contains(status.Error, "ready") {
		t.Errorf("applied %+v, status %+v", h.applied, status)
	}
	if len(h.exports) != 1 {
		t.Errorf("the Kindle's collections are still exported: %d exports", len(h.exports))
	}
}

func TestAnUnreadableLibraryIsAnErrorWithNoExport(t *testing.T) {
	h := &harness{readErr: errors.New("cc.db is locked")}
	h.desired, h.ready = desiredFile("mirror", `[]`)

	status, _ := Run(context.Background(), h.deps())

	if status.Result != contract.ResultError || !strings.Contains(status.Error, "cc.db is locked") {
		t.Errorf("status = %+v", status)
	}
	if len(h.exports)+len(h.applied) != 0 {
		t.Errorf("nothing may be exported or applied without the library: %d exports, %d applies", len(h.exports), len(h.applied))
	}
}

func TestAFailedApplyIsReportedAndNothingCountsAsApplied(t *testing.T) {
	h := &harness{libraries: []library.Library{{Items: []library.Item{book("b1", "Dune.azw3")}}}, applyErr: errors.New("catalog: 500")}
	h.desired, h.ready = desiredFile("mirror", `[{"name":"SF","members":["Dune.azw3"]}]`)

	status, _ := Run(context.Background(), h.deps())

	if status.Result != contract.ResultError || status.AppliedDesired != nil || !strings.Contains(status.Error, "500") {
		t.Errorf("status = %+v", status)
	}
}

func TestWaitsABoundedTimeForBooksStillBeingIndexed(t *testing.T) {
	notYet := library.Library{Items: []library.Item{book("b1", "Dune.azw3")}}
	indexed := library.Library{Items: []library.Item{book("b1", "Dune.azw3"), book("b2", "Nuovo.azw3")}}
	h := &harness{libraries: []library.Library{notYet, indexed}}
	h.desired, h.ready = desiredFile("mirror", `[{"name":"SF","members":["Dune.azw3","Nuovo.azw3"]}]`)

	status, _ := Run(context.Background(), h.deps())

	if h.sleeps != 1 || len(h.applied) != 1 || len(h.applied[0].Inserts[0].Members) != 2 {
		t.Errorf("sleeps %d, applied %+v", h.sleeps, h.applied)
	}
	if status.Result != contract.ResultOK || len(status.PendingBooks) != 0 {
		t.Errorf("status = %+v", status)
	}
}

func TestBooksNeverIndexedAreReportedPendingAndTheRestIsApplied(t *testing.T) {
	h := &harness{libraries: []library.Library{{Items: []library.Item{book("b1", "Dune.azw3")}}}}
	h.desired, h.ready = desiredFile("mirror", `[{"name":"SF","members":["Dune.azw3","Nuovo.azw3"]}]`)

	status, _ := Run(context.Background(), h.deps())

	if h.sleeps != 3 {
		t.Errorf("waited %d times, want IndexWaits (3)", h.sleeps)
	}
	if len(h.applied) != 1 || status.Result != contract.ResultPartial || status.AppliedDesired == nil {
		t.Errorf("applied %d, status %+v", len(h.applied), status)
	}
	if len(status.PendingBooks) != 1 || status.PendingBooks[0] != "Nuovo.azw3" {
		t.Errorf("pending = %v", status.PendingBooks)
	}
}

func TestAMirrorWithNothingToChangeSendsNothing(t *testing.T) {
	h := &harness{libraries: []library.Library{{
		Items:       []library.Item{book("b1", "Dune.azw3")},
		Collections: []library.Collection{{UUID: "k1", Name: "SF", Members: []string{"b1"}}},
	}}}
	h.desired, h.ready = desiredFile("mirror", `[{"name":"SF","members":["Dune.azw3"]}]`)

	status, _ := Run(context.Background(), h.deps())

	if len(h.applied) != 0 || status.Result != contract.ResultOK || status.AppliedDesired == nil {
		t.Errorf("applied %+v, status %+v", h.applied, status)
	}
}

func TestExportListsTheAppsBooksAndCountsTheRest(t *testing.T) {
	lib := library.Library{
		Items: []library.Item{book("b1", "Dune.azw3"), {UUID: "c1", Type: library.ItemType, CdeKey: "B00X"}, book("t1", "Note.txt")},
		Collections: []library.Collection{
			{UUID: "k1", Name: "Mix", Members: []string{"b1", "c1", "t1", "gone"}},
			{UUID: "k2", Name: "  ", Members: []string{"b1"}},
		},
	}

	export := ExportOf(lib)

	if len(export.Collections) != 1 {
		t.Fatalf("an unnamed collection is left out (the app would refuse the whole file): %+v", export)
	}
	got := export.Collections[0]
	if got.Name != "Mix" || len(got.Members) != 1 || got.Members[0] != "Dune.azw3" || got.OtherMembers != 3 {
		t.Errorf("export = %+v", got)
	}
}

func TestAStatusThatCannotBeWrittenIsReturnedAsAnError(t *testing.T) {
	h := &harness{libraries: []library.Library{{}}, desiredErr: devicefs.ErrNoDesired}
	deps := h.deps()
	deps.WriteStatus = func(contract.Status) error { return errors.New("read-only file system") }

	if _, err := Run(context.Background(), deps); err == nil {
		t.Error("expected the write failure to be returned")
	}
}

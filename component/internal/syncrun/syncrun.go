// Package syncrun is one sync, run after the USB cable is unplugged:
//
//  1. read the Kindle's collections (a cc.db snapshot) and export them — the
//     first-sync question and the record of what existed before this run;
//  2. read desired.json; in `mirror` mode plan the changes, waiting a bounded
//     time for books the firmware is still indexing;
//  3. apply the plan through the catalog service, export again;
//  4. write status.json, which the app reads at the next connection.
package syncrun

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
	"github.com/gfoiani/kindle-organizer/component/internal/devicefs"
	"github.com/gfoiani/kindle-organizer/component/internal/library"
	"github.com/gfoiani/kindle-organizer/component/internal/plan"
)

// Deps are everything a run touches, so a run can be tested without a Kindle.
type Deps struct {
	// DeviceReady fails while /mnt/us is not the device's: not remounted yet
	// after an unplug, or exported again because the cable went back in. Writing
	// then would land in the bare mountpoint on the system partition.
	DeviceReady func(ctx context.Context) error
	ReadDesired func() (text, ready []byte, err error)
	ReadLibrary func(ctx context.Context) (library.Library, error)
	Apply       func(ctx context.Context, p plan.Plan) error
	WriteExport func(contract.Export) error
	WriteStatus func(contract.Status) error
	NewUUID     func() string
	Now         func() time.Time
	Sleep       func(time.Duration)
	DeviceID    string
	Version     string
	// IndexWaits × IndexInterval bounds the wait for books not indexed yet.
	IndexWaits    int
	IndexInterval time.Duration
	// ReadyWaits × ReadyInterval bounds the wait for /mnt/us at the start of a run.
	ReadyWaits    int
	ReadyInterval time.Duration
}

// Run does one sync and writes its status. An error means the run touched
// nothing more (the USB drive was not the device's) or its status could not be
// written; every other outcome is reported inside the status.
func Run(ctx context.Context, d Deps) (contract.Status, error) {
	if err := d.waitUntilReady(); err != nil {
		return contract.Status{}, fmt.Errorf("the USB drive is not the device's: %w", err)
	}
	status, err := d.run(ctx)
	if err != nil {
		return status, err
	}
	if err := d.DeviceReady(ctx); err != nil {
		return status, fmt.Errorf("not writing status.json: %w", err)
	}
	status.FinishedAt = d.Now().UTC().Format(time.RFC3339)
	if err := d.WriteStatus(status); err != nil {
		return status, fmt.Errorf("writing status.json: %w", err)
	}
	return status, nil
}

func (d Deps) waitUntilReady() error {
	for attempt := 0; ; attempt++ {
		err := d.DeviceReady(context.Background())
		if err == nil || attempt >= d.ReadyWaits {
			return err
		}
		d.Sleep(d.ReadyInterval)
	}
}

// run returns an error only when it stopped because /mnt/us was taken back.
func (d Deps) run(ctx context.Context) (contract.Status, error) {
	base := contract.NewStatus(d.DeviceID, d.Version)
	lib, err := d.ReadLibrary(ctx)
	if err != nil {
		return base.WithError(fmt.Errorf("reading the Kindle's collections: %w", err)), nil
	}
	if err := d.WriteExport(ExportOf(lib)); err != nil {
		return base.WithError(fmt.Errorf("writing export.json: %w", err)), nil
	}

	desired, hash, err := d.loadDesired()
	if errors.Is(err, devicefs.ErrNoDesired) {
		return base, nil
	}
	if err != nil {
		return base.WithError(err), nil
	}
	if desired.Mode != contract.ModeMirror {
		return base, nil
	}
	return d.mirror(ctx, base, desired, hash, lib)
}

func (d Deps) loadDesired() (contract.Desired, string, error) {
	text, ready, err := d.ReadDesired()
	if err != nil {
		return contract.Desired{}, "", err
	}
	return contract.ParseDesired(text, ready)
}

func (d Deps) mirror(ctx context.Context, base contract.Status, desired contract.Desired, hash string, lib library.Library) (contract.Status, error) {
	p := plan.Compute(desired.Collections, lib, d.NewUUID)
	for wait := 0; len(p.Pending) > 0 && wait < d.IndexWaits; wait++ {
		d.Sleep(d.IndexInterval)
		if err := d.DeviceReady(ctx); err != nil {
			return base, fmt.Errorf("stopped while waiting for indexing: %w", err)
		}
		next, err := d.ReadLibrary(ctx)
		if err != nil {
			return base.WithError(fmt.Errorf("re-reading the Kindle's collections: %w", err)), nil
		}
		p = plan.Compute(desired.Collections, next, d.NewUUID)
	}

	status := base
	if !p.Empty() {
		if err := d.DeviceReady(ctx); err != nil {
			return base, fmt.Errorf("stopped before applying: %w", err)
		}
		if err := d.Apply(ctx, p); err != nil {
			return base.WithError(fmt.Errorf("applying the collections: %w", err)), nil
		}
		if err := d.refreshExport(ctx); err != nil {
			// The changes are in; only the app's view of them is stale until the next run.
			status.Error = fmt.Sprintf("applied, but export.json was not refreshed: %v", err)
		}
	}

	applied := hash
	status.Created, status.Updated, status.Deleted = len(p.Inserts), len(p.Updates), len(p.Deletes)+len(p.Merged)
	status.PendingBooks = append([]string{}, p.Pending...)
	status.AppliedDesired = &applied
	if len(p.Pending) > 0 {
		status.Result = contract.ResultPartial
	}
	return status, nil
}

func (d Deps) refreshExport(ctx context.Context) error {
	lib, err := d.ReadLibrary(ctx)
	if err != nil {
		return err
	}
	return d.WriteExport(ExportOf(lib))
}

// ExportOf lists each named Kindle collection with the app's books as relpaths
// and a count of the rest. An unnamed collection is left out: the app refuses
// the whole file when one name is blank.
func ExportOf(lib library.Library) contract.Export {
	relpaths := map[string]string{}
	for _, item := range lib.Items {
		if relpath, ok := item.Relpath(); ok {
			relpaths[item.UUID] = relpath
		}
	}

	collections := []contract.ExportCollection{}
	for _, collection := range lib.Collections {
		name := strings.TrimSpace(collection.Name)
		if name == "" {
			continue
		}
		entry := contract.ExportCollection{Name: name, Members: []string{}}
		for _, uuid := range collection.Members {
			if relpath, ok := relpaths[uuid]; ok {
				entry.Members = append(entry.Members, relpath)
			} else {
				entry.OtherMembers++
			}
		}
		collections = append(collections, entry)
	}
	return contract.Export{Schema: contract.SchemaVersion, Collections: collections}
}

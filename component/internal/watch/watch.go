// Package watch decides when to sync: once at start (outside USB drive mode),
// then every time the Kindle leaves USB drive mode — the moment the user has
// unplugged it and /mnt/us belongs to the device again.
//
// It blocks on the firmware's event tool rather than polling, so an idle
// Kindle does no work; WaitForChange must also return after a long timeout,
// which makes the drive-mode check a slow fallback if an event is missed.
package watch

import (
	"context"
	"time"
)

// ErrorBackoff is the pause after a failed event wait, so a broken tool never spins the CPU.
const ErrorBackoff = time.Minute

type Watcher struct {
	// WaitForChange blocks until a USB event or a timeout (both are a nil return).
	WaitForChange func(ctx context.Context) error
	InDriveMode   func(ctx context.Context) (bool, error)
	Sync          func(ctx context.Context) error
	Sleep         func(time.Duration)
	// Settle lets the firmware remount /mnt/us and start indexing before the sync.
	Settle time.Duration
	Log    func(format string, args ...any)
}

func (w Watcher) Loop(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	wasInDriveMode := w.driveMode(ctx)
	if !wasInDriveMode {
		w.sync(ctx)
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := w.WaitForChange(ctx); err != nil {
			w.Log("waiting for a USB event: %v", err)
			w.Sleep(ErrorBackoff)
		}
		inDriveMode := w.driveMode(ctx)
		if err := ctx.Err(); err != nil {
			return err
		}
		if wasInDriveMode && !inDriveMode {
			w.Sleep(w.Settle)
			w.sync(ctx)
		}
		wasInDriveMode = inDriveMode
	}
}

// driveMode reads an unreadable state as "not plugged in": syncing when it is
// not needed is harmless, never syncing is not.
func (w Watcher) driveMode(ctx context.Context) bool {
	inDriveMode, err := w.InDriveMode(ctx)
	if err != nil {
		w.Log("reading the USB drive mode: %v", err)
		return false
	}
	return inDriveMode
}

func (w Watcher) sync(ctx context.Context) {
	if err := w.Sync(ctx); err != nil {
		w.Log("sync: %v", err)
	}
}

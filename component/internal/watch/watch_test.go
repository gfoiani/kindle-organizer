package watch

import (
	"context"
	"errors"
	"testing"
	"time"
)

// script plays back the drive-mode readings in order; the loop stops when they run out.
type script struct {
	readings []bool
	readErr  error
	waits    int
	waitErr  error
	syncs    int
	syncErr  error
	sleeps   []time.Duration
	logs     int
}

func (s *script) watcher(cancel context.CancelFunc) Watcher {
	return Watcher{
		WaitForChange: func(context.Context) error {
			s.waits++
			return s.waitErr
		},
		InDriveMode: func(context.Context) (bool, error) {
			if len(s.readings) == 0 {
				cancel()
				return false, nil
			}
			reading := s.readings[0]
			s.readings = s.readings[1:]
			return reading, s.readErr
		},
		Sync: func(context.Context) error {
			s.syncs++
			return s.syncErr
		},
		Sleep:  func(d time.Duration) { s.sleeps = append(s.sleeps, d) },
		Settle: 5 * time.Second,
		Log:    func(string, ...any) { s.logs++ },
	}
}

func run(s *script) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	return s.watcher(cancel).Loop(ctx)
}

func TestSyncsOnceAtStartSoTheAppSeesTheComponent(t *testing.T) {
	s := &script{readings: []bool{false}}

	_ = run(s)

	if s.syncs != 1 {
		t.Errorf("%d syncs, want the start-up one", s.syncs)
	}
}

func TestSyncsWhenTheKindleLeavesUSBDriveMode(t *testing.T) {
	// start (not in drive mode) → plugged in → unplugged
	s := &script{readings: []bool{false, true, false}}

	_ = run(s)

	if s.syncs != 2 {
		t.Errorf("%d syncs, want start-up + one after the unplug", s.syncs)
	}
	if len(s.sleeps) != 1 || s.sleeps[0] != 5*time.Second {
		t.Errorf("sleeps = %v: the unplug sync waits Settle first", s.sleeps)
	}
}

func TestDoesNotSyncOnEventsThatAreNotAnUnplug(t *testing.T) {
	// still out of drive mode, then plugged in and staying plugged
	s := &script{readings: []bool{false, false, true, true}}

	_ = run(s)

	if s.syncs != 1 {
		t.Errorf("%d syncs, want only the start-up one", s.syncs)
	}
}

func TestStartingWhilePluggedInWaitsForTheUnplug(t *testing.T) {
	// /mnt/us is exported over USB at that moment: there is nothing to write to.
	s := &script{readings: []bool{true, false}}

	_ = run(s)

	if s.syncs != 1 {
		t.Errorf("%d syncs, want only the one after the unplug", s.syncs)
	}
}

func TestAFailedSyncIsLoggedAndTheLoopGoesOn(t *testing.T) {
	s := &script{readings: []bool{false, true, false, true, false}, syncErr: errors.New("boom")}

	_ = run(s)

	if s.syncs != 3 || s.logs < 3 {
		t.Errorf("syncs %d, logs %d: every failure is logged, none stops the loop", s.syncs, s.logs)
	}
}

func TestAFailingEventWaitBacksOffInsteadOfSpinning(t *testing.T) {
	s := &script{readings: []bool{false, false, false}, waitErr: errors.New("lipc-wait-event: not found")}

	_ = run(s)

	if s.waits == 0 || len(s.sleeps) != s.waits {
		t.Fatalf("%d waits, sleeps %v: each failed wait sleeps once", s.waits, s.sleeps)
	}
	for _, d := range s.sleeps {
		if d != ErrorBackoff {
			t.Errorf("slept %v, want ErrorBackoff", d)
		}
	}
}

func TestAnUnreadableDriveModeCountsAsNotPluggedIn(t *testing.T) {
	s := &script{readings: []bool{true, true}, readErr: errors.New("lipc-get-prop failed")}

	_ = run(s)

	// Read as "not plugged in": the start-up sync runs, and no unplug is ever seen.
	if s.syncs != 1 || s.logs == 0 {
		t.Errorf("syncs %d, logs %d", s.syncs, s.logs)
	}
}

func TestLoopEndsWithTheContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &script{readings: []bool{false}}

	if err := s.watcher(cancel).Loop(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
	if s.syncs != 0 {
		t.Errorf("a cancelled loop must not sync: %d", s.syncs)
	}
}

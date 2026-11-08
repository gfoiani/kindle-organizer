// Command kosync is Kindle Organizer's collection sync for a Kindle
// jailbroken with jb.sh. It applies the collections the app leaves in
// /mnt/us/kindle-organizer/desired.json through the firmware's catalog
// service, after every unplug.
//
//	kosync watch    sync now (outside USB drive mode), then after every unplug
//	kosync run      one sync now
//	kosync version  print the version
//
// Only wiring lives here; every rule is in internal/ and unit-tested.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gfoiani/kindle-organizer/component/internal/catalog"
	"github.com/gfoiani/kindle-organizer/component/internal/contract"
	"github.com/gfoiani/kindle-organizer/component/internal/devicefs"
	"github.com/gfoiani/kindle-organizer/component/internal/library"
	"github.com/gfoiani/kindle-organizer/component/internal/syncrun"
	"github.com/gfoiani/kindle-organizer/component/internal/watch"
)

// version is reported in status.json; the app compares it to offer updates.
const version = "0.1.0"

const (
	// stateDir is on the device's own flash, never exported over USB.
	stateDir      = "/var/local/kindle-organizer"
	liveDB        = "/var/local/cc.db"
	logMaxBytes   = 1 << 20
	settle        = 10 * time.Second
	indexWaits    = 12
	indexInterval = 10 * time.Second
	batchSize     = 100
	maxRetries    = 5
	httpTimeout   = 2 * time.Minute
	// eventTimeout bounds each event wait: a missed event delays a sync by at most this.
	eventTimeout = 15 * time.Minute
	// minInterval follows every event wait, so the loop never spins.
	minInterval = 5 * time.Second
	// readyWaits × readyInterval: how long a sync waits for /mnt/us to be remounted.
	readyWaits    = 12
	readyInterval = 5 * time.Second
	// childTimeout bounds sqlite3 and lipc-get-prop, so a hung tool cannot stall the loop.
	childTimeout = 2 * time.Minute
	// usbMount is the USB partition; while it is exported over USB it is not mounted here.
	usbMount = "/mnt/us"
)

// usbEvents are the com.lab126.hal events that announce a cable change.
// TO VERIFY on the device (diagnostics/emergency.sh records them): with a
// wrong name every wait ends at eventTimeout, so the sync still happens, late.
var usbEvents = []string{"usbPlugIn", "usbPlugOut"}

const usage = "usage: kosync watch|run|version"

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "run":
		if err := syncOnce(ctx); err != nil {
			logf("%v", err)
			os.Exit(1)
		}
	case "watch":
		if err := watcher().Loop(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logf("watch: %v", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}

func watcher() watch.Watcher {
	return watch.Watcher{
		WaitForChange: waitForUSBEvent,
		InDriveMode:   inDriveMode,
		Sync:          syncOnce,
		Sleep:         time.Sleep,
		Settle:        settle,
		MinInterval:   minInterval,
		Log:           logf,
	}
}

func syncOnce(ctx context.Context) error {
	deviceID, err := devicefs.LoadOrCreateDeviceID(filepath.Join(stateDir, "device-id"), newUUID)
	if err != nil {
		return fmt.Errorf("device id: %w", err)
	}
	dir := devicefs.Dir{Root: devicefs.DefaultRoot}
	reader := library.Reader{SQLite: "sqlite3", LiveDB: liveDB, SnapshotPath: filepath.Join(stateDir, "cc-snapshot.db"), Run: withTimeout(library.ExecRunner)}
	client := catalog.Client{
		URL:        catalog.DefaultURL,
		Token:      catalog.FileToken(catalog.SessionTokenFile),
		HTTP:       &http.Client{Timeout: httpTimeout},
		BatchSize:  batchSize,
		MaxRetries: maxRetries,
		Sleep:      time.Sleep,
		Now:        time.Now,
	}

	status, err := syncrun.Run(ctx, syncrun.Deps{
		DeviceReady:   deviceReady,
		ReadDesired:   dir.ReadDesired,
		ReadLibrary:   reader.Read,
		Apply:         client.Apply,
		WriteExport:   func(e contract.Export) error { return dir.WriteExport(e) },
		WriteStatus:   func(s contract.Status) error { return dir.WriteStatus(s) },
		NewUUID:       newUUID,
		Now:           time.Now,
		Sleep:         time.Sleep,
		DeviceID:      deviceID,
		Version:       version,
		IndexWaits:    indexWaits,
		IndexInterval: indexInterval,
		ReadyWaits:    readyWaits,
		ReadyInterval: readyInterval,
	})
	logf("sync: %s, created %d, updated %d, deleted %d, pending %d %s",
		status.Result, status.Created, status.Updated, status.Deleted, len(status.PendingBooks), status.Error)
	publishLog(dir)
	return err
}

// waitForUSBEvent blocks on lipc-wait-event until a cable event, eventTimeout
// or shutdown; the last two are a normal return, not an error.
func waitForUSBEvent(ctx context.Context) error {
	waitCtx, cancel := context.WithTimeout(ctx, eventTimeout)
	defer cancel()
	cmd := exec.CommandContext(waitCtx, "lipc-wait-event", "com.lab126.hal", strings.Join(usbEvents, ","))
	cmd.WaitDelay = 5 * time.Second
	killWithParent(cmd)
	err := cmd.Run()
	if waitCtx.Err() != nil {
		return nil
	}
	return err
}

// withTimeout bounds every call of run by childTimeout.
func withTimeout(run library.Runner) library.Runner {
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		callCtx, cancel := context.WithTimeout(ctx, childTimeout)
		defer cancel()
		return run(callCtx, name, args...)
	}
}

// deviceReady fails unless the USB partition is mounted here and not in USB drive mode.
func deviceReady(ctx context.Context) error {
	mounted, err := isMounted(usbMount)
	if err != nil {
		return err
	}
	if !mounted {
		return fmt.Errorf("%s is not mounted", usbMount)
	}
	plugged, err := inDriveMode(ctx)
	if err != nil {
		return err
	}
	if plugged {
		return errors.New("the Kindle is in USB drive mode")
	}
	return nil
}

func isMounted(mountpoint string) (bool, error) {
	raw, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if fields := strings.Fields(line); len(fields) > 1 && fields[1] == mountpoint {
			return true, nil
		}
	}
	return false, nil
}

func inDriveMode(ctx context.Context) (bool, error) {
	out, err := withTimeout(library.ExecRunner)(ctx, "lipc-get-prop", "com.lab126.volumd", "driveModeState")
	if err != nil {
		return false, err
	}
	text := strings.TrimSpace(string(out))
	state, err := strconv.Atoi(text)
	if err != nil {
		return false, fmt.Errorf("driveModeState %q: %w", text, err)
	}
	return state != 0, nil
}

// newUUID is a random (v4) UUID.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// The kernel's entropy source is gone: there is nothing sensible left to do.
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// logf appends one line to the log in stateDir, opening and closing the file
// each time; it is cut to its newest half when it passes logMaxBytes.
func logf(format string, args ...any) {
	line := fmt.Sprintf("%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	if err := appendLine(filepath.Join(stateDir, "log.txt"), line); err != nil {
		fmt.Fprintf(os.Stderr, "log: %v\n%s", err, line)
	}
}

func appendLine(file, line string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(file); err == nil && info.Size() > logMaxBytes {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if err := os.WriteFile(file, data[len(data)/2:], 0o644); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(line); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// publishLog copies the log's tail to /mnt/us/kindle-organizer/log.txt for bug reports.
func publishLog(dir devicefs.Dir) {
	data, err := os.ReadFile(filepath.Join(stateDir, "log.txt"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "reading the log: %v\n", err)
		return
	}
	if err := dir.WriteLog(data); err != nil {
		fmt.Fprintf(os.Stderr, "publishing the log: %v\n", err)
	}
}

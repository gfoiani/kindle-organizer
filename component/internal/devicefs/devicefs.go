// Package devicefs reads and writes the exchange files in the USB partition's
// kindle-organizer/ folder. Every write is temp file + fsync + rename, so a
// file the app reads is never half-written.
package devicefs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// DefaultRoot is the exchange folder as the device sees it.
const DefaultRoot = "/mnt/us/kindle-organizer"

// MaxDesiredBytes bounds desired.json: far above any real library, far below the device's memory.
const MaxDesiredBytes = 32 << 20

const maxReadyBytes = 1 << 10

// ErrNoDesired means the app has not written a desired.json yet.
var ErrNoDesired = errors.New("no desired.json on the device")

type Dir struct {
	Root string
}

// ReadDesired returns desired.json and desired.ready. A missing marker is nil,
// not an error: refusing an unmarked file is ParseDesired's job.
func (d Dir) ReadDesired() ([]byte, []byte, error) {
	text, err := readCapped(filepath.Join(d.Root, "desired.json"), MaxDesiredBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrNoDesired
	}
	if err != nil {
		return nil, nil, err
	}
	ready, err := readCapped(filepath.Join(d.Root, "desired.ready"), maxReadyBytes)
	if errors.Is(err, os.ErrNotExist) {
		return text, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return text, ready, nil
}

func (d Dir) WriteStatus(status any) error {
	return d.writeJSON("status.json", status)
}

func (d Dir) WriteExport(export any) error {
	return d.writeJSON("export.json", export)
}

// MaxLogBytes bounds the log.txt copy users attach to a bug report.
const MaxLogBytes = 256 << 10

// WriteLog publishes the newest MaxLogBytes of the component's log as log.txt.
// The log itself lives off the USB partition: a file kept open on /mnt/us
// would stop the Kindle from exporting it over USB.
func (d Dir) WriteLog(log []byte) error {
	if len(log) > MaxLogBytes {
		log = log[len(log)-MaxLogBytes:]
	}
	if err := os.MkdirAll(d.Root, 0o755); err != nil {
		return err
	}
	return writeAtomically(filepath.Join(d.Root, "log.txt"), log)
}

func (d Dir) writeJSON(name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encoding %s: %w", name, err)
	}
	if err := os.MkdirAll(d.Root, 0o755); err != nil {
		return err
	}
	return writeAtomically(filepath.Join(d.Root, name), append(raw, '\n'))
}

func readCapped(file string, limit int64) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", file, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", file, limit)
	}
	return data, nil
}

func writeAtomically(file string, data []byte) (err error) {
	temp := file + ".tmp"
	defer func() {
		if err != nil {
			if removeErr := os.Remove(temp); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				err = errors.Join(err, removeErr)
			}
		}
	}()
	f, err := os.Create(temp)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(temp, file)
}

var deviceID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// LoadOrCreateDeviceID returns the id stored in file, creating it with newID
// the first time (or when what is stored is unusable). The app keys the
// first-sync answer on it, so it lives outside the USB partition: a copy of
// that partition onto another Kindle does not bring the id along.
func LoadOrCreateDeviceID(file string, newID func() string) (string, error) {
	raw, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if id := strings.TrimSpace(string(raw)); deviceID.MatchString(id) {
		return id, nil
	}
	id := newID()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	if err := writeAtomically(file, []byte(id+"\n")); err != nil {
		return "", err
	}
	return id, nil
}

// Package contract mirrors src/main/kindleSync/syncFiles.ts: the files the app
// and this component exchange under /mnt/us/kindle-organizer/.
//
//	desired.json   app → device: the collections the Kindle should hold
//	desired.ready  app → device: sha256 of desired.json, written last
//	export.json    device → app: the Kindle's collections after each run
//	status.json    device → app: how the last run went
//
// desired.json is validated whole: a file that does not match is never applied.
package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"
)

const (
	SchemaVersion = 1
	// MaxCollections and MaxMembers match the limits the app enforces on what the device writes.
	MaxCollections = 5000
	MaxMembers     = 100_000
	// MaxErrorRunes is how much of an error message the app keeps.
	MaxErrorRunes = 1000
)

// Mode is `hold` until the first-sync question is answered; `mirror` applies the collections.
type Mode string

const (
	ModeHold   Mode = "hold"
	ModeMirror Mode = "mirror"
)

// ErrNotReady means desired.ready is missing or names another desired.json:
// the app has not finished writing it, or the cable was pulled mid-write.
var ErrNotReady = errors.New("desired.json is not marked ready")

type DesiredCollection struct {
	Name string `json:"name"`
	// Members are relpaths under documents/, as the app keys books.
	Members []string `json:"members"`
}

type Desired struct {
	Schema      int                 `json:"schema"`
	Mode        Mode                `json:"mode"`
	Collections []DesiredCollection `json:"collections"`
}

// Hash is the sha256 (hex) the app writes into desired.ready and expects back in appliedDesired.
func Hash(text []byte) string {
	sum := sha256.Sum256(text)
	return hex.EncodeToString(sum[:])
}

// ParseDesired checks the ready marker, then the schema. It returns the file's hash with it.
func ParseDesired(text, ready []byte) (Desired, string, error) {
	hash := Hash(text)
	if strings.TrimSpace(string(ready)) != hash {
		return Desired{}, "", ErrNotReady
	}

	var raw struct {
		Schema      int                  `json:"schema"`
		Mode        Mode                 `json:"mode"`
		Collections *[]DesiredCollection `json:"collections"`
	}
	if err := json.Unmarshal(text, &raw); err != nil {
		return Desired{}, "", fmt.Errorf("desired.json: %w", err)
	}
	if raw.Schema != SchemaVersion {
		return Desired{}, "", fmt.Errorf("desired.json: schema %d, want %d", raw.Schema, SchemaVersion)
	}
	if raw.Mode != ModeHold && raw.Mode != ModeMirror {
		return Desired{}, "", fmt.Errorf("desired.json: unknown mode %q", raw.Mode)
	}
	if raw.Collections == nil {
		return Desired{}, "", errors.New("desired.json: no collections list")
	}
	collections, err := validCollections(*raw.Collections)
	if err != nil {
		return Desired{}, "", fmt.Errorf("desired.json: %w", err)
	}
	return Desired{Schema: raw.Schema, Mode: raw.Mode, Collections: collections}, hash, nil
}

func validCollections(collections []DesiredCollection) ([]DesiredCollection, error) {
	if len(collections) > MaxCollections {
		return nil, fmt.Errorf("%d collections, more than %d", len(collections), MaxCollections)
	}
	out := make([]DesiredCollection, 0, len(collections))
	total := 0
	for _, collection := range collections {
		name := strings.TrimSpace(collection.Name)
		if name == "" {
			return nil, errors.New("a collection has no name")
		}
		for _, member := range collection.Members {
			if !IsDocumentsRelpath(member) {
				return nil, fmt.Errorf("collection %q lists %q, which is not under documents/", name, member)
			}
		}
		total += len(collection.Members)
		if total > MaxMembers {
			return nil, fmt.Errorf("more than %d members", MaxMembers)
		}
		out = append(out, DesiredCollection{Name: name, Members: append([]string{}, collection.Members...)})
	}
	return out, nil
}

var driveLetter = regexp.MustCompile(`^[A-Za-z]:`)

// IsDocumentsRelpath is the app's isDocumentsRelpath: relative, POSIX, never leaving documents/.
func IsDocumentsRelpath(relpath string) bool {
	if relpath == "" || strings.HasPrefix(relpath, "/") || driveLetter.MatchString(relpath) {
		return false
	}
	for _, segment := range strings.Split(relpath, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

// Fold is the comparison key for relpaths and names: the volume is FAT (case-
// insensitive) and macOS hands back decomposed names, so NFC + lower case.
func Fold(text string) string {
	return strings.ToLower(norm.NFC.String(text))
}

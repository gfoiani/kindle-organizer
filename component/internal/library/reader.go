package library

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Runner runs a program and returns its standard output.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// ExecRunner runs the program for real, folding its stderr into the error.
func ExecRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// Reader reads cc.db through the device's own sqlite3: a `.backup` snapshot
// first, then queries on the snapshot. Every value is selected as hex, so no
// name, path or title can break the output's columns. There is no WHERE or
// ORDER BY: cc.db's columns use an ICU collation the stock sqlite3 lacks, and
// a full scan never asks for it.
type Reader struct {
	SQLite       string
	LiveDB       string
	SnapshotPath string
	Run          Runner
}

const (
	entriesQuery = "SELECT hex(p_type), hex(p_uuid), hex(ifnull(p_location,'')), hex(ifnull(p_cdeKey,'')), hex(ifnull(p_titles_0_nominal,'')) FROM Entries;"
	membersQuery = "SELECT hex(i_collection_uuid), hex(i_member_uuid) FROM Collections;"
)

func (r Reader) Read(ctx context.Context) (lib Library, err error) {
	if _, err := os.Stat(r.LiveDB); err != nil {
		return Library{}, fmt.Errorf("cc.db: %w", err)
	}
	if err := removeIfPresent(r.SnapshotPath); err != nil {
		return Library{}, err
	}
	defer func() {
		if cleanupErr := removeIfPresent(r.SnapshotPath); cleanupErr != nil && err == nil {
			err = cleanupErr
		}
	}()

	if _, err := r.Run(ctx, r.SQLite, "-init", os.DevNull, "-batch", "-readonly", r.LiveDB, fmt.Sprintf(".backup '%s'", r.SnapshotPath)); err != nil {
		return Library{}, fmt.Errorf("snapshot of cc.db: %w", err)
	}
	entries, err := r.query(ctx, entriesQuery, 5)
	if err != nil {
		return Library{}, err
	}
	members, err := r.query(ctx, membersQuery, 2)
	if err != nil {
		return Library{}, err
	}
	return buildLibrary(entries, members), nil
}

func (r Reader) query(ctx context.Context, sql string, columns int) ([][]string, error) {
	out, err := r.Run(ctx, r.SQLite, "-init", os.DevNull, "-batch", "-noheader", "-list", "-separator", "|", "-readonly", r.SnapshotPath, sql)
	if err != nil {
		return nil, fmt.Errorf("reading cc.db: %w", err)
	}
	return parseHexRows(out, columns)
}

func removeIfPresent(file string) error {
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing the cc.db snapshot: %w", err)
	}
	return nil
}

// parseHexRows decodes sqlite3's list output where every column is hex(...).
func parseHexRows(out []byte, columns int) ([][]string, error) {
	var rows [][]string
	for number, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "|")
		if len(fields) != columns {
			return nil, fmt.Errorf("cc.db output line %d has %d columns, want %d", number+1, len(fields), columns)
		}
		row := make([]string, columns)
		for i, field := range fields {
			value, err := hex.DecodeString(field)
			if err != nil {
				return nil, fmt.Errorf("cc.db output line %d: %w", number+1, err)
			}
			row[i] = string(value)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func buildLibrary(entries, members [][]string) Library {
	membersOf := map[string][]string{}
	for _, row := range members {
		membersOf[row[0]] = append(membersOf[row[0]], row[1])
	}

	var lib Library
	for _, row := range entries {
		kind, uuid, location, cdeKey, title := row[0], row[1], row[2], row[3], row[4]
		switch {
		case uuid == "":
			continue
		case kind == ItemType || strings.HasPrefix(kind, ItemType+":"):
			lib.Items = append(lib.Items, Item{UUID: uuid, Type: kind, Location: location, CdeKey: cdeKey})
		case kind == "Collection":
			lib.Collections = append(lib.Collections, Collection{UUID: uuid, Name: title, Members: append([]string{}, membersOf[uuid]...)})
		}
	}
	return lib
}

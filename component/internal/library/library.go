// Package library is the Kindle's own view of its books and collections, read
// from a snapshot of /var/local/cc.db — never from the live file, which the
// framework holds open.
package library

import (
	"path"
	"strings"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
)

// DocumentsDir is where the USB partition's documents/ folder lives on the device.
const DocumentsDir = "/mnt/us/documents/"

// ItemType is the cc.db type of a plain book; dictionaries and the like are "Entry:Item:<kind>".
const ItemType = "Entry:Item"

// bookExtensions are the formats the app lists (SUPPORTED_EXTENSIONS in src/main/kindle.ts):
// only those books are the app's to place; anything else in a collection is left there.
var bookExtensions = map[string]bool{".mobi": true, ".azw": true, ".azw3": true, ".kfx": true, ".epub": true, ".pdf": true}

type Item struct {
	UUID     string
	Type     string
	Location string
	CdeKey   string
}

type Collection struct {
	UUID    string
	Name    string
	Members []string
}

type Library struct {
	Items       []Item
	Collections []Collection
}

// Relpath is the item's key under documents/ when it is a book the app lists.
func (item Item) Relpath() (string, bool) {
	relpath, found := strings.CutPrefix(item.Location, DocumentsDir)
	if !found || !contract.IsDocumentsRelpath(relpath) {
		return "", false
	}
	if !bookExtensions[strings.ToLower(path.Ext(relpath))] {
		return "", false
	}
	return relpath, true
}

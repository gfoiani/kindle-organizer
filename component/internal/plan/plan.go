// Package plan computes what to send to the catalog service so the Kindle
// holds the app's collections — over the books the app can see only.
//
// The rules (docs/superpowers/specs/2026-11-01-kindle-collections-sync-design.md):
//   - a collection the app has is created when missing, but never empty;
//   - its members become the app's books for it, plus the members it already
//     had that are not books the app lists (Amazon/cloud items stay);
//   - a Kindle collection the app does not have is deleted (books never are);
//   - names and relpaths match ignoring case and Unicode form, so an existing
//     collection is updated rather than replaced (which would lose its cloud items).
package plan

import (
	"sort"
	"strings"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
	"github.com/gfoiani/kindle-organizer/component/internal/library"
)

type Insert struct {
	UUID    string
	Name    string
	Members []string
}

// MemberUpdate sets a collection's exact member list (omitted members are dropped).
type MemberUpdate struct {
	UUID    string
	Members []string
}

// CountUpdate is a book's new collectionCount, which the home screen shows.
type CountUpdate struct {
	UUID  string
	Count int
}

type Plan struct {
	Inserts []Insert
	Updates []MemberUpdate
	// Deletes are Kindle collections the app does not have.
	Deletes []string
	// Merged are same-named duplicates folded into a kept collection. They are
	// deleted only after the member updates, so a failed update never loses
	// the Amazon items they held.
	Merged []string
	Counts []CountUpdate
	// Pending are desired books the firmware has not indexed yet.
	Pending []string
}

// Empty reports whether there is nothing to send. Pending books are not an action.
func (p Plan) Empty() bool {
	return len(p.Inserts)+len(p.Updates)+len(p.Deletes)+len(p.Merged)+len(p.Counts) == 0
}

type group struct {
	name     string
	relpaths []string
}

// Compute plans the changes. newUUID names created collections.
func Compute(desired []contract.DesiredCollection, lib library.Library, newUUID func() string) Plan {
	books, appBooks := indexBooks(lib.Items)
	existing := map[string][]library.Collection{}
	for _, collection := range lib.Collections {
		key := nameKey(collection.Name)
		existing[key] = append(existing[key], collection)
	}

	var p Plan
	groups := mergeGroups(desired)
	pending := newOrderedSet()
	merged := map[string]bool{}
	updated := map[string][]string{}
	wanted := map[string]bool{}
	for _, g := range groups {
		wanted[nameKey(g.name)] = true
		members := resolveMembers(g.relpaths, books, pending)
		collections := existing[nameKey(g.name)]
		if len(collections) == 0 {
			if len(members) > 0 {
				p.Inserts = append(p.Inserts, Insert{UUID: newUUID(), Name: g.name, Members: members})
			}
			continue
		}
		kept := pickKept(collections, g.name)
		next := withForeignMembers(members, kept, collections, appBooks)
		if !sameSet(next, kept.Members) {
			p.Updates = append(p.Updates, MemberUpdate{UUID: kept.UUID, Members: next})
			updated[kept.UUID] = next
		}
		for _, other := range collections {
			if other.UUID != kept.UUID {
				merged[other.UUID] = true
			}
		}
	}

	gone := map[string]bool{}
	for _, collection := range lib.Collections {
		switch {
		case merged[collection.UUID]:
			p.Merged = append(p.Merged, collection.UUID)
		case !wanted[nameKey(collection.Name)]:
			p.Deletes = append(p.Deletes, collection.UUID)
		default:
			continue
		}
		gone[collection.UUID] = true
	}

	p.Pending = pending.values
	p.Counts = countChanges(lib, p.Inserts, updated, gone)
	return p
}

func nameKey(name string) string {
	return contract.Fold(strings.TrimSpace(name))
}

// indexBooks maps each book the app lists, by folded relpath, to its uuid.
func indexBooks(items []library.Item) (map[string]string, map[string]bool) {
	books := map[string]string{}
	appBooks := map[string]bool{}
	for _, item := range items {
		if relpath, ok := item.Relpath(); ok {
			books[contract.Fold(relpath)] = item.UUID
			appBooks[item.UUID] = true
		}
	}
	return books, appBooks
}

// mergeGroups joins desired collections whose names fold together, keeping the first spelling.
func mergeGroups(desired []contract.DesiredCollection) []group {
	var groups []group
	index := map[string]int{}
	for _, collection := range desired {
		key := nameKey(collection.Name)
		if i, seen := index[key]; seen {
			groups[i].relpaths = append(groups[i].relpaths, collection.Members...)
			continue
		}
		index[key] = len(groups)
		groups = append(groups, group{name: strings.TrimSpace(collection.Name), relpaths: append([]string{}, collection.Members...)})
	}
	return groups
}

func resolveMembers(relpaths []string, books map[string]string, pending *orderedSet) []string {
	members := newOrderedSet()
	for _, relpath := range relpaths {
		if uuid, indexed := books[contract.Fold(relpath)]; indexed {
			members.add(uuid)
		} else {
			pending.add(relpath)
		}
	}
	return members.values
}

// pickKept prefers the collection spelled exactly like the app's, else the first.
func pickKept(collections []library.Collection, name string) library.Collection {
	for _, collection := range collections {
		if strings.TrimSpace(collection.Name) == name {
			return collection
		}
	}
	return collections[0]
}

// withForeignMembers appends the members the app cannot see, from the kept
// collection first and then from the same-named ones about to be deleted.
func withForeignMembers(members []string, kept library.Collection, collections []library.Collection, appBooks map[string]bool) []string {
	next := newOrderedSet()
	for _, uuid := range members {
		next.add(uuid)
	}
	ordered := append([]library.Collection{kept}, collections...)
	for _, collection := range ordered {
		for _, uuid := range collection.Members {
			if !appBooks[uuid] {
				next.add(uuid)
			}
		}
	}
	return next.values
}

func sameSet(a, b []string) bool {
	left, right := map[string]bool{}, map[string]bool{}
	for _, v := range a {
		left[v] = true
	}
	for _, v := range b {
		right[v] = true
	}
	if len(left) != len(right) {
		return false
	}
	for v := range left {
		if !right[v] {
			return false
		}
	}
	return true
}

// countChanges is the collectionCount of every plain book whose count moves.
func countChanges(lib library.Library, inserts []Insert, updated map[string][]string, deleted map[string]bool) []CountUpdate {
	before, after := map[string]int{}, map[string]int{}
	for _, collection := range lib.Collections {
		countMembers(before, collection.Members)
		if deleted[collection.UUID] {
			continue
		}
		if members, ok := updated[collection.UUID]; ok {
			countMembers(after, members)
		} else {
			countMembers(after, collection.Members)
		}
	}
	for _, insert := range inserts {
		countMembers(after, insert.Members)
	}

	var counts []CountUpdate
	for _, item := range lib.Items {
		if item.Type == library.ItemType && before[item.UUID] != after[item.UUID] {
			counts = append(counts, CountUpdate{UUID: item.UUID, Count: after[item.UUID]})
		}
	}
	sort.Slice(counts, func(i, j int) bool { return counts[i].UUID < counts[j].UUID })
	return counts
}

func countMembers(counts map[string]int, members []string) {
	seen := map[string]bool{}
	for _, uuid := range members {
		if !seen[uuid] {
			seen[uuid] = true
			counts[uuid]++
		}
	}
}

// orderedSet keeps first-seen order; values are compared folded, so a relpath
// listed twice with different case is pending once.
type orderedSet struct {
	seen   map[string]bool
	values []string
}

func newOrderedSet() *orderedSet {
	return &orderedSet{seen: map[string]bool{}, values: []string{}}
}

func (s *orderedSet) add(value string) {
	key := contract.Fold(value)
	if s.seen[key] {
		return
	}
	s.seen[key] = true
	s.values = append(s.values, value)
}

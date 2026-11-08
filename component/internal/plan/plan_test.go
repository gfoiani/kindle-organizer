package plan

import (
	"fmt"
	"reflect"
	"sort"
	"testing"

	"github.com/gfoiani/kindle-organizer/component/internal/contract"
	"github.com/gfoiani/kindle-organizer/component/internal/library"
)

func book(uuid, relpath string) library.Item {
	return library.Item{UUID: uuid, Type: "Entry:Item", Location: "/mnt/us/documents/" + relpath}
}

func cloudItem(uuid string) library.Item {
	return library.Item{UUID: uuid, Type: "Entry:Item", CdeKey: "B0" + uuid}
}

func want(name string, members ...string) contract.DesiredCollection {
	if members == nil {
		members = []string{}
	}
	return contract.DesiredCollection{Name: name, Members: members}
}

// sequentialUUIDs hands out new-0, new-1, … so inserts are predictable.
func sequentialUUIDs() func() string {
	n := 0
	return func() string {
		id := fmt.Sprintf("new-%d", n)
		n++
		return id
	}
}

func sorted(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}

func TestCreatesAMissingCollectionWithItsBooks(t *testing.T) {
	lib := library.Library{Items: []library.Item{book("b1", "Dune.azw3"), book("b2", "Emma.pdf")}}

	p := Compute([]contract.DesiredCollection{want("Fantascienza", "Dune.azw3")}, lib, sequentialUUIDs())

	if !reflect.DeepEqual(p.Inserts, []Insert{{UUID: "new-0", Name: "Fantascienza", Members: []string{"b1"}}}) {
		t.Errorf("inserts = %+v", p.Inserts)
	}
	if len(p.Updates)+len(p.Deletes) != 0 {
		t.Errorf("nothing else to do: %+v", p)
	}
}

func TestNeverCreatesACollectionWithNoBooksOnTheDevice(t *testing.T) {
	lib := library.Library{Items: []library.Item{book("b1", "Dune.azw3")}}

	p := Compute([]contract.DesiredCollection{want("Vuota")}, lib, sequentialUUIDs())

	if !p.Empty() {
		t.Errorf("an app collection with no books here must not be created: %+v", p)
	}
}

func TestKeepsAnExistingCollectionAndTheMembersTheAppCannotSee(t *testing.T) {
	// "Vuota" holds an Amazon item and a sideloaded book the app has removed from it.
	lib := library.Library{
		Items:       []library.Item{book("b1", "Dune.azw3"), cloudItem("c1")},
		Collections: []library.Collection{{UUID: "k1", Name: "Vuota", Members: []string{"c1", "b1"}}},
	}

	p := Compute([]contract.DesiredCollection{want("Vuota")}, lib, sequentialUUIDs())

	if len(p.Deletes) != 0 {
		t.Errorf("a collection the app has must not be deleted, even with no books here: %+v", p.Deletes)
	}
	if !reflect.DeepEqual(p.Updates, []MemberUpdate{{UUID: "k1", Members: []string{"c1"}}}) {
		t.Errorf("updates = %+v (the cloud item stays, the removed book goes)", p.Updates)
	}
}

func TestChangesNothingWhenTheKindleAlreadyMatches(t *testing.T) {
	lib := library.Library{
		Items:       []library.Item{book("b1", "Dune.azw3"), book("b2", "Emma.pdf"), cloudItem("c1")},
		Collections: []library.Collection{{UUID: "k1", Name: "Mix", Members: []string{"c1", "b2", "b1"}}},
	}

	p := Compute([]contract.DesiredCollection{want("Mix", "Dune.azw3", "Emma.pdf")}, lib, sequentialUUIDs())

	if !p.Empty() {
		t.Errorf("member order is not a difference: %+v", p)
	}
}

func TestAddsAndRemovesBooksInAnExistingCollection(t *testing.T) {
	lib := library.Library{
		Items:       []library.Item{book("b1", "Dune.azw3"), book("b2", "Emma.pdf")},
		Collections: []library.Collection{{UUID: "k1", Name: "Mix", Members: []string{"b1"}}},
	}

	p := Compute([]contract.DesiredCollection{want("Mix", "Emma.pdf")}, lib, sequentialUUIDs())

	if len(p.Updates) != 1 || !reflect.DeepEqual(p.Updates[0].Members, []string{"b2"}) {
		t.Errorf("updates = %+v", p.Updates)
	}
}

func TestDeletesKindleCollectionsTheAppDoesNotHave(t *testing.T) {
	lib := library.Library{
		Items:       []library.Item{book("b1", "Dune.azw3")},
		Collections: []library.Collection{{UUID: "k1", Name: "Vecchia", Members: []string{"b1"}}},
	}

	p := Compute(nil, lib, sequentialUUIDs())

	if !reflect.DeepEqual(p.Deletes, []string{"k1"}) {
		t.Errorf("deletes = %v", p.Deletes)
	}
}

func TestMatchesNamesIgnoringCaseAndUnicodeForm(t *testing.T) {
	// Deleting and re-creating would lose the Amazon item the Kindle's "città" holds.
	lib := library.Library{
		Items:       []library.Item{book("b1", "Dune.azw3"), cloudItem("c1")},
		Collections: []library.Collection{{UUID: "k1", Name: "città", Members: []string{"c1"}}},
	}

	p := Compute([]contract.DesiredCollection{want("Città", "Dune.azw3")}, lib, sequentialUUIDs())

	if len(p.Inserts)+len(p.Deletes) != 0 {
		t.Errorf("the same collection must be updated, not replaced: %+v", p)
	}
	if len(p.Updates) != 1 || !reflect.DeepEqual(sorted(p.Updates[0].Members), []string{"b1", "c1"}) {
		t.Errorf("updates = %+v", p.Updates)
	}
}

func TestMergesSameNamedKindleCollectionsIntoOne(t *testing.T) {
	lib := library.Library{
		Items: []library.Item{book("b1", "Dune.azw3"), cloudItem("c1"), cloudItem("c2")},
		Collections: []library.Collection{
			{UUID: "k1", Name: "giallo", Members: []string{"c1"}},
			{UUID: "k2", Name: "Giallo", Members: []string{"c2"}},
		},
	}

	p := Compute([]contract.DesiredCollection{want("Giallo", "Dune.azw3")}, lib, sequentialUUIDs())

	if !reflect.DeepEqual(p.Deletes, []string{"k1"}) {
		t.Errorf("the exact-name collection is kept, the other deleted: deletes = %v", p.Deletes)
	}
	if len(p.Updates) != 1 || p.Updates[0].UUID != "k2" || !reflect.DeepEqual(sorted(p.Updates[0].Members), []string{"b1", "c1", "c2"}) {
		t.Errorf("the kept one gathers the other's Amazon items: %+v", p.Updates)
	}
}

func TestBooksNotIndexedYetArePendingNotMembers(t *testing.T) {
	lib := library.Library{Items: []library.Item{book("b1", "Dune.azw3")}}

	p := Compute([]contract.DesiredCollection{want("Nuovi", "Dune.azw3", "Appena inviato.azw3", "Appena inviato.azw3")}, lib, sequentialUUIDs())

	if !reflect.DeepEqual(p.Pending, []string{"Appena inviato.azw3"}) {
		t.Errorf("pending = %v", p.Pending)
	}
	if len(p.Inserts) != 1 || !reflect.DeepEqual(p.Inserts[0].Members, []string{"b1"}) {
		t.Errorf("inserts = %+v", p.Inserts)
	}
}

func TestMatchesBooksIgnoringCaseAndUnicodeForm(t *testing.T) {
	lib := library.Library{Items: []library.Item{book("b1", "Città/DUNE.AZW3")}}

	p := Compute([]contract.DesiredCollection{want("Viaggi", "Città/Dune.azw3")}, lib, sequentialUUIDs())

	if len(p.Pending) != 0 || len(p.Inserts) != 1 || !reflect.DeepEqual(p.Inserts[0].Members, []string{"b1"}) {
		t.Errorf("plan = %+v", p)
	}
}

func TestDesiredNamesThatFoldTogetherAreOneCollection(t *testing.T) {
	lib := library.Library{Items: []library.Item{book("b1", "Dune.azw3"), book("b2", "Emma.pdf")}}

	p := Compute([]contract.DesiredCollection{want("Mix", "Dune.azw3"), want("MIX", "Emma.pdf")}, lib, sequentialUUIDs())

	if len(p.Inserts) != 1 || !reflect.DeepEqual(sorted(p.Inserts[0].Members), []string{"b1", "b2"}) {
		t.Errorf("inserts = %+v", p.Inserts)
	}
}

func TestUpdatesTheCollectionCountOfBooksWhoseMembershipChanges(t *testing.T) {
	lib := library.Library{
		Items: []library.Item{book("b1", "Dune.azw3"), book("b2", "Emma.pdf"), book("b3", "Odissea.pdf"), {UUID: "d1", Type: "Entry:Item:Dictionary", Location: "/mnt/us/documents/dict.azw"}},
		Collections: []library.Collection{
			{UUID: "k1", Name: "A", Members: []string{"b1", "b3"}},
			{UUID: "k2", Name: "Vecchia", Members: []string{"b2", "d1"}},
		},
	}

	p := Compute([]contract.DesiredCollection{want("A", "Dune.azw3", "Emma.pdf", "Odissea.pdf"), want("B", "Dune.azw3")}, lib, sequentialUUIDs())

	// b1: 1 → 2 (A, B). b2: 1 → 1 (Vecchia deleted, joins A): unchanged. b3: unchanged.
	// d1 leaves Vecchia, but only plain Entry:Item rows get a count update.
	if !reflect.DeepEqual(p.Counts, []CountUpdate{{UUID: "b1", Count: 2}}) {
		t.Errorf("counts = %+v", p.Counts)
	}
}

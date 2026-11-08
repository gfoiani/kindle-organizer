package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gfoiani/kindle-organizer/component/internal/plan"
)

const lastAccess = 1700000000

func marshal(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestCommandsUseTheShapesTheFirmwareAccepts(t *testing.T) {
	// The shapes ccsync (MIT) sends to the same service on 5.x firmware.
	p := plan.Plan{
		Deletes: []string{"k9"},
		Inserts: []plan.Insert{{UUID: "new-0", Name: "Fantascienza", Members: []string{"b1"}}},
		Updates: []plan.MemberUpdate{{UUID: "k1", Members: []string{"b2", "c1"}}},
		Merged:  []string{"k8"},
		Counts:  []plan.CountUpdate{{UUID: "b1", Count: 2}},
	}

	batches := Batches(p, lastAccess, 100)

	if len(batches) != 1 {
		t.Fatalf("one batch expected, got %d", len(batches))
	}
	want := []string{
		`{"delete":{"uuid":"k9"}}`,
		`{"insert":{"collectionCount":null,"collectionDataSetName":"new-0","collections":null,"isArchived":1,"isVisibleInHome":1,"lastAccess":1700000000,"mimeType":"application/x-kindle-collection","titles":[{"display":"Fantascienza"}],"type":"Collection","uuid":"new-0"}}`,
		`{"update":{"members":["b1"],"type":"Collection","uuid":"new-0"}}`,
		`{"update":{"members":["b2","c1"],"type":"Collection","uuid":"k1"}}`,
		`{"delete":{"uuid":"k8"}}`,
		`{"update":{"collectionCount":2,"type":"Entry:Item","uuid":"b1"}}`,
	}
	if len(batches[0]) != len(want) {
		t.Fatalf("%d commands, want %d: %s", len(batches[0]), len(want), marshal(t, batches[0]))
	}
	for i, command := range batches[0] {
		if got := marshal(t, command); got != want[i] {
			t.Errorf("command %d:\n got %s\nwant %s", i, got, want[i])
		}
	}
}

func TestBatchesNeverSplitAnInsertFromItsMembers(t *testing.T) {
	p := plan.Plan{Inserts: []plan.Insert{
		{UUID: "a", Name: "A", Members: []string{"b1"}},
		{UUID: "b", Name: "B", Members: []string{"b2"}},
	}, Deletes: []string{"k1"}}

	batches := Batches(p, lastAccess, 2)

	// delete | insert a + members | insert b + members
	if len(batches) != 3 || len(batches[0]) != 1 || len(batches[1]) != 2 || len(batches[2]) != 2 {
		t.Fatalf("batches = %s", marshal(t, batches))
	}
}

func TestAnEmptyPlanHasNoBatches(t *testing.T) {
	if batches := Batches(plan.Plan{Pending: []string{"x.azw3"}}, lastAccess, 100); len(batches) != 0 {
		t.Errorf("batches = %v", batches)
	}
}

type recorded struct {
	path        string
	authToken   []string
	contentType string
	body        map[string]any
}

// fakeService answers with the given status codes in turn (200 once they run out).
func fakeService(t *testing.T, codes []int, replyBody string) (*httptest.Server, *[]recorded) {
	t.Helper()
	var mu sync.Mutex
	var requests []recorded
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		// The server canonicalizes header names; the exact spelling is checked on the client side (headerSpy).
		requests = append(requests, recorded{path: r.URL.Path, authToken: r.Header.Values("AuthToken"), contentType: r.Header.Get("Content-Type"), body: body})
		code := http.StatusOK
		if len(requests) <= len(codes) {
			code = codes[len(requests)-1]
		}
		w.WriteHeader(code)
		_, _ = io.WriteString(w, replyBody)
	}))
	t.Cleanup(server.Close)
	return server, &requests
}

func client(server *httptest.Server, sleeps *[]time.Duration) Client {
	return Client{
		URL:        server.URL + "/change",
		Token:      func() (string, error) { return "tok-123", nil },
		HTTP:       server.Client(),
		BatchSize:  2,
		MaxRetries: 3,
		Sleep:      func(d time.Duration) { *sleeps = append(*sleeps, d) },
		Now:        func() time.Time { return time.Unix(lastAccess, 0) },
	}
}

var twoBatches = plan.Plan{Deletes: []string{"k1", "k2", "k3"}}

// headerSpy records the header names exactly as the client hands them to the transport.
type headerSpy struct {
	base http.RoundTripper
	keys *[]string
}

func (s headerSpy) RoundTrip(r *http.Request) (*http.Response, error) {
	for key := range r.Header {
		*s.keys = append(*s.keys, key)
	}
	return s.base.RoundTrip(r)
}

func TestApplyPostsEachBatchAsAChangeRequestWithTheSessionToken(t *testing.T) {
	server, requests := fakeService(t, nil, `{"ok":true}`)
	var sleeps []time.Duration
	var keys []string
	c := client(server, &sleeps)
	c.HTTP = &http.Client{Transport: headerSpy{base: server.Client().Transport, keys: &keys}}

	err := c.Apply(context.Background(), twoBatches)

	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(keys, "AuthToken") {
		t.Errorf("the token header must be sent spelled exactly AuthToken, got %v", keys)
	}
	if len(*requests) != 2 {
		t.Fatalf("%d requests, want 2", len(*requests))
	}
	for i, r := range *requests {
		if r.path != "/change" || len(r.authToken) != 1 || r.authToken[0] != "tok-123" || !strings.HasPrefix(r.contentType, "application/json") {
			t.Errorf("request %d: path %q, AuthToken %v, Content-Type %q", i, r.path, r.authToken, r.contentType)
		}
		if r.body["type"] != "ChangeRequest" || r.body["id"] != float64(i+1) {
			t.Errorf("request %d envelope: %v", i, r.body)
		}
	}
	if commands := (*requests)[0].body["commands"].([]any); len(commands) != 2 {
		t.Errorf("first batch carries %d commands, want 2", len(commands))
	}
}

func TestApplyRetriesWhileTheServiceIsBusy(t *testing.T) {
	server, requests := fakeService(t, []int{http.StatusServiceUnavailable, http.StatusServiceUnavailable}, `{"ok":true}`)
	var sleeps []time.Duration

	err := client(server, &sleeps).Apply(context.Background(), plan.Plan{Deletes: []string{"k1"}})

	if err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 3 || len(sleeps) != 2 || sleeps[1] <= sleeps[0] {
		t.Errorf("requests %d, sleeps %v: two busy replies, two growing waits, then success", len(*requests), sleeps)
	}
}

func TestApplyGivesUpWhenTheServiceStaysBusy(t *testing.T) {
	busy := []int{503, 503, 503, 503, 503, 503}
	server, requests := fakeService(t, busy, "")
	var sleeps []time.Duration

	err := client(server, &sleeps).Apply(context.Background(), plan.Plan{Deletes: []string{"k1"}})

	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Errorf("err = %v", err)
	}
	if len(*requests) != 4 {
		t.Errorf("%d requests: one try plus MaxRetries", len(*requests))
	}
}

func TestApplyStopsAtTheFirstRefusedBatch(t *testing.T) {
	server, requests := fakeService(t, []int{http.StatusInternalServerError}, "boom")
	var sleeps []time.Duration

	err := client(server, &sleeps).Apply(context.Background(), twoBatches)

	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Errorf("err = %v", err)
	}
	if len(*requests) != 1 {
		t.Errorf("%d requests: nothing after a refused batch", len(*requests))
	}
}

func TestApplyTreatsAnOkFalseReplyAsAFailure(t *testing.T) {
	server, _ := fakeService(t, nil, `{"ok":false,"error":"bad command"}`)
	var sleeps []time.Duration

	err := client(server, &sleeps).Apply(context.Background(), plan.Plan{Deletes: []string{"k1"}})

	if err == nil || !strings.Contains(err.Error(), "bad command") {
		t.Errorf("err = %v", err)
	}
}

func TestApplySendsNothingWithoutASessionToken(t *testing.T) {
	server, requests := fakeService(t, nil, `{"ok":true}`)
	var sleeps []time.Duration
	c := client(server, &sleeps)
	c.Token = func() (string, error) { return "", errors.New("no token") }

	if err := c.Apply(context.Background(), plan.Plan{Deletes: []string{"k1"}}); err == nil {
		t.Error("expected an error")
	}
	if len(*requests) != 0 {
		t.Errorf("%d requests sent without a token", len(*requests))
	}
}

func TestApplyOfAnEmptyPlanSendsNothing(t *testing.T) {
	server, requests := fakeService(t, nil, `{"ok":true}`)
	var sleeps []time.Duration

	if err := client(server, &sleeps).Apply(context.Background(), plan.Plan{}); err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 0 {
		t.Errorf("%d requests for an empty plan", len(*requests))
	}
}

func TestFileTokenReadsTheSessionTokenTrimmed(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "session_token")
	if err := os.WriteFile(token, []byte("abc123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got, err := FileToken(token)(); err != nil || got != "abc123" {
		t.Errorf("token = %q, %v", got, err)
	}
	if _, err := FileToken(empty)(); err == nil {
		t.Error("an empty token file must be an error")
	}
	if _, err := FileToken(filepath.Join(dir, "absent"))(); err == nil {
		t.Error("a missing token file must be an error")
	}
}

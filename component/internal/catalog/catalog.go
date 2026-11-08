// Package catalog sends a plan to the firmware's catalog service
// (POST http://127.0.0.1:9101/change), the only safe way to change cc.db while
// the framework runs. The command shapes are the ones ccsync (MIT, sandman7920)
// sends to the same service on 5.x firmware.
package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gfoiani/kindle-organizer/component/internal/plan"
)

// DefaultURL is the catalog service on the device.
const DefaultURL = "http://127.0.0.1:9101/change"

// SessionTokenFile holds the AuthToken the service wants; it changes every boot.
const SessionTokenFile = "/tmp/session_token"

const (
	collectionMime = "application/x-kindle-collection"
	firstRetryWait = 500 * time.Millisecond
	maxReplyBytes  = 64 << 10
	maxReplyQuote  = 300
)

// Command is one entry of a ChangeRequest's commands list.
type Command map[string]any

// Batches turns a plan into ChangeRequest command lists of at most size
// commands: deletes first (they free names), then each insert followed by its
// member list — never split across requests — then member updates, then
// collection counts.
func Batches(p plan.Plan, lastAccess int64, size int) [][]Command {
	var units [][]Command
	for _, uuid := range p.Deletes {
		units = append(units, []Command{{"delete": map[string]any{"uuid": uuid}}})
	}
	for _, insert := range p.Inserts {
		units = append(units, []Command{insertCommand(insert, lastAccess), membersCommand(insert.UUID, insert.Members)})
	}
	for _, update := range p.Updates {
		units = append(units, []Command{membersCommand(update.UUID, update.Members)})
	}
	for _, count := range p.Counts {
		units = append(units, []Command{{"update": map[string]any{"type": "Entry:Item", "uuid": count.UUID, "collectionCount": count.Count}}})
	}
	return pack(units, size)
}

func insertCommand(insert plan.Insert, lastAccess int64) Command {
	return Command{"insert": map[string]any{
		"type":                  "Collection",
		"uuid":                  insert.UUID,
		"lastAccess":            lastAccess,
		"titles":                []map[string]any{{"display": insert.Name}},
		"isVisibleInHome":       1,
		"isArchived":            1,
		"mimeType":              collectionMime,
		"collections":           nil,
		"collectionCount":       nil,
		"collectionDataSetName": insert.UUID,
	}}
}

func membersCommand(uuid string, members []string) Command {
	return Command{"update": map[string]any{"type": "Collection", "uuid": uuid, "members": append([]string{}, members...)}}
}

func pack(units [][]Command, size int) [][]Command {
	var batches [][]Command
	var current []Command
	for _, unit := range units {
		if len(current) > 0 && len(current)+len(unit) > size {
			batches = append(batches, current)
			current = nil
		}
		current = append(current, unit...)
	}
	if len(current) > 0 {
		batches = append(batches, current)
	}
	return batches
}

// Client posts batches to the service. A 503 (busy) is retried with growing
// waits; any other failure stops the run. The plan is recomputed from cc.db on
// every run, so whatever a failed run did not send is sent the next time.
type Client struct {
	URL        string
	Token      func() (string, error)
	HTTP       *http.Client
	BatchSize  int
	MaxRetries int
	Sleep      func(time.Duration)
	Now        func() time.Time
}

func (c Client) Apply(ctx context.Context, p plan.Plan) error {
	batches := Batches(p, c.Now().Unix(), c.BatchSize)
	if len(batches) == 0 {
		return nil
	}
	token, err := c.Token()
	if err != nil {
		return fmt.Errorf("catalog session token: %w", err)
	}
	for i, batch := range batches {
		body, err := json.Marshal(map[string]any{"type": "ChangeRequest", "id": i + 1, "commands": batch})
		if err != nil {
			return fmt.Errorf("encoding batch %d: %w", i+1, err)
		}
		if err := c.send(ctx, token, body); err != nil {
			return fmt.Errorf("catalog batch %d of %d: %w", i+1, len(batches), err)
		}
	}
	return nil
}

func (c Client) send(ctx context.Context, token string, body []byte) error {
	wait := firstRetryWait
	for attempt := 0; ; attempt++ {
		code, reply, err := c.post(ctx, token, body)
		if err != nil {
			return err
		}
		if code == http.StatusServiceUnavailable && attempt < c.MaxRetries {
			c.Sleep(wait)
			wait *= 2
			continue
		}
		return checkReply(code, reply)
	}
}

func (c Client) post(ctx context.Context, token string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	// The service matches the header name exactly; Header.Set would canonicalize it to "Authtoken".
	req.Header["AuthToken"] = []string{token}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("posting to the catalog service: %w", err)
	}
	defer resp.Body.Close()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, maxReplyBytes))
	if err != nil {
		return 0, nil, fmt.Errorf("reading the catalog service reply: %w", err)
	}
	return resp.StatusCode, reply, nil
}

func checkReply(code int, reply []byte) error {
	if code != http.StatusOK {
		return fmt.Errorf("the catalog service answered %d: %s", code, quote(reply))
	}
	var answer struct {
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(reply, &answer) == nil && answer.OK != nil && !*answer.OK {
		detail := answer.Error
		if detail == "" {
			detail = quote(reply)
		}
		return fmt.Errorf("the catalog service refused the change: %s", detail)
	}
	return nil
}

func quote(reply []byte) string {
	text := strings.TrimSpace(string(reply))
	if len(text) > maxReplyQuote {
		return text[:maxReplyQuote] + "…"
	}
	return text
}

// FileToken reads the session token from file each time it is asked: it changes every boot.
func FileToken(file string) func() (string, error) {
	return func() (string, error) {
		raw, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		token := strings.TrimSpace(string(raw))
		if token == "" {
			return "", errors.New(file + " is empty")
		}
		return token, nil
	}
}

package contract

// Result is how a run ended, as the app's DeviceRunResult.
type Result string

const (
	ResultInstalled Result = "installed"
	ResultOK        Result = "ok"
	// ResultPartial: applied, but some desired books were not indexed yet (retried next unplug).
	ResultPartial Result = "partial"
	ResultError   Result = "error"
)

// Status is status.json. The app validates it whole, so every field is always written.
type Status struct {
	Schema           int    `json:"schema"`
	DeviceID         string `json:"deviceId"`
	ComponentVersion string `json:"componentVersion"`
	// FinishedAt is ISO-8601 UTC.
	FinishedAt   string   `json:"finishedAt"`
	Result       Result   `json:"result"`
	Created      int      `json:"created"`
	Updated      int      `json:"updated"`
	Deleted      int      `json:"deleted"`
	PendingBooks []string `json:"pendingBooks"`
	// AppliedDesired is the Hash of the desired.json this run applied; nil when none was.
	AppliedDesired *string `json:"appliedDesired"`
	Error          string  `json:"error,omitempty"`
}

// NewStatus is an "ok, nothing applied" status for this device and component version.
func NewStatus(deviceID, version string) Status {
	return Status{
		Schema:           SchemaVersion,
		DeviceID:         deviceID,
		ComponentVersion: version,
		Result:           ResultOK,
		PendingBooks:     []string{},
	}
}

// WithError returns a copy reporting the failure: result error, nothing applied.
func (s Status) WithError(err error) Status {
	s.Result = ResultError
	s.AppliedDesired = nil
	s.Error = capRunes(err.Error(), MaxErrorRunes)
	return s
}

func capRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// ExportCollection is one Kindle collection as export.json lists it.
type ExportCollection struct {
	Name string `json:"name"`
	// Members are the books the app lists, as relpaths under documents/.
	Members []string `json:"members"`
	// OtherMembers counts the rest: Amazon/cloud items, files the app does not list.
	OtherMembers int `json:"otherMembers"`
}

// Export is export.json: the Kindle's collections after a run.
type Export struct {
	Schema      int                `json:"schema"`
	Collections []ExportCollection `json:"collections"`
}

package control

import "testing"

func TestMappingReach(t *testing.T) {
	cases := []struct {
		en                                bool
		mode, listen, push, node, err     string
		granted                           bool
		active, max                       int
		want                              string
	}{
		{false, "public", "listening", "acked", "online", "", true, 0, 8, "disabled"},
		{true, "public", "error", "error", "online", "bind", true, 0, 8, "error"},
		{true, "public", "listening", "pending_offline", "offline", "", true, 0, 8, "offline"},
		{true, "public", "pending", "pending", "online", "", true, 0, 8, "pending"},
		{true, "spa", "listening", "acked", "online", "", false, 0, 8, "closed"},
		{true, "spa", "listening", "acked", "online", "", true, 0, 8, "open"},
		{true, "public", "listening", "acked", "online", "", true, 8, 8, "full"},
		{true, "visitor", "ready", "acked", "online", "", false, 0, 8, "visitor"},
	}
	for _, tc := range cases {
		got := mappingReach(tc.en, tc.mode, tc.listen, tc.push, tc.node, tc.err, tc.granted, tc.active, tc.max)
		if got != tc.want {
			t.Fatalf("%+v -> %s want %s", tc, got, tc.want)
		}
	}
}

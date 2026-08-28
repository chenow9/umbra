package policy

import "testing"

func TestCidrAllowedIPv4AndIPv6BareAddress(t *testing.T) {
	if !CidrAllowed("10.0.0.1", "10.0.0.1") {
		t.Fatal("ipv4 exact")
	}
	if CidrAllowed("10.0.0.2", "10.0.0.1") {
		t.Fatal("ipv4 other")
	}
	if !CidrAllowed("2001:db8::1", "2001:db8::1") {
		t.Fatal("ipv6 exact should be /128 not /32")
	}
}

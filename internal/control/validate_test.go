package control

import "testing"

func TestValidNodeName(t *testing.T) {
	for _, name := range []string{"home-nas", "家里 NAS", "n1", "studio.local"} {
		if err := validNodeName(name); err != nil {
			t.Errorf("%q: %v", name, err)
		}
	}
	for _, name := range []string{"", "   ", "!!! bad/name?", "---", "a/b", "no?"} {
		if err := validNodeName(name); err == nil {
			t.Errorf("%q: accepted", name)
		}
	}
}

func TestValidLocalHost(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "localhost", "nas.local", "::1", "[::1]", "my_nas"} {
		if !validLocalHost(host) {
			t.Errorf("%q: rejected", host)
		}
	}
	for _, host := range []string{"", "not_a_host!!!", "host name", "a/b"} {
		if validLocalHost(host) {
			t.Errorf("%q: accepted", host)
		}
	}
}

func TestValidCidrsExamples(t *testing.T) {
	if err := validateCidrs(""); err != nil {
		t.Fatal(err)
	}
	if err := validateCidrs("10.0.0.0/8, 192.168.1.1"); err != nil {
		t.Fatal(err)
	}
	if err := validateCidrs("not-a-cidr"); err == nil {
		t.Fatal("not-a-cidr accepted")
	}
}

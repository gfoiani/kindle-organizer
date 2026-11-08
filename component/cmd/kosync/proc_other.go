//go:build !linux

package main

import "os/exec"

// killWithParent is Linux-only (Pdeathsig); elsewhere kosync is only built for tests.
func killWithParent(*exec.Cmd) {}

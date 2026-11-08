//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// killWithParent makes the child die with kosync, so no lipc-wait-event outlives it.
func killWithParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

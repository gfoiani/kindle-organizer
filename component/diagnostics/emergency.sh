#!/bin/sh
# Kindle Organizer — one-off, read-only diagnostic for the collection sync.
#
# jb.sh runs /mnt/us/emergency.sh as root at boot. This script deletes itself
# first, so it runs exactly once, then records what the sync component needs to
# know about this Kindle. It changes nothing on the device: it writes only
# /mnt/us/kindle-organizer-diagnostics.txt, plus scratch files in /tmp.
# The report holds no collection names, book paths or tokens.
#
# Use: copy this file to the root of the Kindle's USB drive as emergency.sh,
# eject, restart the Kindle. Within 10 minutes of the restart, plug the cable in
# and unplug it once. Then the report is at the root of the USB drive.

SELF=/mnt/us/emergency.sh
REPORT=/mnt/us/kindle-organizer-diagnostics.txt
WORK=/tmp/kindle-organizer-diagnostics
WATCH_SECONDS=600
# Longest wait for /mnt/us to come back before giving up on the USB part.
REMOUNT_WAIT_SECONDS=3600

rm -f "$SELF"
mkdir -p "$WORK"

section() { printf '\n== %s\n' "$1"; }

drive_mode() { lipc-get-prop com.lab126.volumd driveModeState 2>&1; }

cc_db_report() {
  if ! sqlite3 -readonly /var/local/cc.db ".backup '$WORK/cc.db'" 2>"$WORK/backup.err"; then
    section "cc.db snapshot FAILED"; cat "$WORK/backup.err"
    return
  fi
  section "Entries columns"; sqlite3 "$WORK/cc.db" "PRAGMA table_info(Entries);" 2>&1 | cut -d'|' -f2,3
  section "Collections columns"; sqlite3 "$WORK/cc.db" "PRAGMA table_info(Collections);" 2>&1 | cut -d'|' -f2,3
  section "Entries by type"; sqlite3 "$WORK/cc.db" "SELECT p_type FROM Entries;" 2>&1 | sort | uniq -c
  section "memberships (rows in Collections)"; sqlite3 "$WORK/cc.db" "SELECT count(*) FROM Collections;" 2>&1
  section "items under /mnt/us/documents/"; sqlite3 "$WORK/cc.db" "SELECT p_location FROM Entries;" 2>&1 | grep -c '^/mnt/us/documents/'
  section "the component's query form (hex, list mode)"
  sqlite3 -init /dev/null -batch -noheader -list -separator '|' -readonly "$WORK/cc.db" "SELECT hex(p_type), hex(p_uuid) FROM Entries LIMIT 1;" 2>&1 | cut -c1-40
  rm -f "$WORK/cc.db"
}

snapshot() {
  section "date (UTC)"; date -u
  section "uname"; uname -a
  section "cpu"; grep -iE 'model name|processor|features|architecture' /proc/cpuinfo | sort -u
  section "firmware"; cat /etc/prettyversion.txt 2>&1
  section "jailbreak"; ls -l /etc/upstart/kmc.conf 2>&1; head -n 3 /mnt/us/documents/JAILBROKEN.txt 2>&1
  section "tools"
  for tool in sqlite3 curl lipc-get-prop lipc-wait-event lipc-probe setsid uniq; do
    printf '%s: ' "$tool"; command -v "$tool" || echo missing
  done
  section "sqlite3 version"; sqlite3 -version 2>&1
  section "cc.db files"; ls -l /var/local/cc.db* 2>&1
  cc_db_report
  section "session token"
  if [ -s /tmp/session_token ]; then echo "present, $(wc -c < /tmp/session_token) bytes"; else echo missing; fi
  section "listening on 9101 (catalog service)"; netstat -ltn 2>&1 | grep -E ':9101( |$)' || echo "not found (or netstat missing)"
  section "driveModeState"; drive_mode
  section "lipc-wait-event usage"; lipc-wait-event 2>&1 | head -n 15
  section "free space (KiB)"; df -k /var/local /mnt/us /tmp 2>&1
}

watch_events() {
  lipc-wait-event -m "$1" "$2" > "$WORK/events-$3.txt" 2>&1 &
  echo $! >> "$WORK/pids"
}

# Runs in the background: everything goes to /tmp while the cable may be in,
# because a file kept open on /mnt/us would stop the USB export.
record_usb() {
  : > "$WORK/pids"
  watch_events com.lab126.hal '*' hal-any
  watch_events com.lab126.hal 'usbPlugIn,usbPlugOut,usbConfigured,usbUnconfigured' hal-named
  watch_events com.lab126.volumd '*' volumd-any
  end=$(( $(date +%s) + WATCH_SECONDS ))
  while [ "$(date +%s)" -lt "$end" ]; do
    printf '%s %s\n' "$(date -u +%H:%M:%S)" "$(drive_mode)" >> "$WORK/drivemode.txt"
    sleep 2
  done
  kill $(cat "$WORK/pids") 2>/dev/null

  # Write the report only once /mnt/us belongs to the device again.
  waited=0
  while [ "$(drive_mode)" != "0" ] && [ "$waited" -lt "$REMOUNT_WAIT_SECONDS" ]; do
    sleep 5
    waited=$(( waited + 5 ))
  done
  {
    section "USB events seen in ${WATCH_SECONDS}s"
    for file in "$WORK"/events-*.txt; do echo "-- $(basename "$file")"; cat "$file"; done
    section "driveModeState every 2 s (changes only)"
    uniq -f1 "$WORK/drivemode.txt"
  } >> "$REPORT" 2>&1
  rm -rf "$WORK"
}

snapshot > "$REPORT" 2>&1
( record_usb ) > /dev/null 2>&1 &
exit 0

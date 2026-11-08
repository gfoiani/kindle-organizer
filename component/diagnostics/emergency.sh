#!/bin/sh
# Kindle Organizer diagnostic v3 (read-only). Bootstrap first: busybox sh reads
# a script while running it, and once /mnt/us/emergency.sh is deleted nothing
# after the rm runs. So copy to /tmp, delete, and carry on from the copy.
SELF=/mnt/us/emergency.sh
RUN=/tmp/kindle-organizer-diagnostics.sh
MARKER=/mnt/us/kindle-organizer-diagnostics-started.txt
if [ "$0" != "$RUN" ]; then
  echo "started $(date -u)" > "$MARKER"
  cp "$SELF" "$RUN"
  rm -f "$SELF"
  sync
  [ -f "$RUN" ] || exit 0
  if command -v setsid >/dev/null 2>&1; then
    setsid /bin/sh "$RUN" detached </dev/null >/dev/null 2>&1 &
  else
    /bin/sh "$RUN" detached </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

# jb.sh runs /mnt/us/emergency.sh as root at boot (kmc.conf pre-start, which
# waits for it). The bootstrap above leaves a marker, deletes the original so it
# runs exactly once, and detaches a copy from /tmp, so boot is never held up.
# The copy records what the sync component needs to know about this Kindle. It
# changes nothing on the device: it writes only
# /mnt/us/kindle-organizer-diagnostics.txt and its marker, plus scratch files in
# /tmp. The report holds no collection names, book paths or tokens.
#
# History on a KT5 / FW 5.18.3: v1 deleted itself and left nothing; v2 left
# its marker (written before the rm) and nothing after it. v3 also:
#   - appends every section separately (the file is never held open) and syncs;
#   - runs every command under a time limit, so nothing can hang it;
#   - does not wait on driveModeState (its format is one of the unknowns): the
#     USB part records to /tmp and copies to /mnt/us only once /mnt/us is
#     mounted read-write on the device again, with a fixed upper bound.
#
# Use: copy this file to the root of the Kindle's USB drive as emergency.sh,
# eject, restart the Kindle. Within 10 minutes of the restart, plug the cable in
# and unplug it once. After 15 minutes, plug it in: the report is at the root.

REPORT=/mnt/us/kindle-organizer-diagnostics.txt
WORK=/tmp/kindle-organizer-diagnostics
WATCH_SECONDS=600
COMMAND_SECONDS=20
# After the watch, how long to wait for /mnt/us to be the device's again.
REMOUNT_WAIT_SECONDS=1800

# Detached copy in /tmp from here on.
echo "running from $RUN ($*)" >> "$MARKER"
sync
mkdir -p "$WORK"

# Runs "$@" with output to stdout, killed after COMMAND_SECONDS. Plain sh: the
# Kindle's busybox may lack `timeout`.
limited() {
  "$@" > "$WORK/out" 2>&1 &
  pid=$!
  ( sleep "$COMMAND_SECONDS"; kill -9 "$pid" 2>/dev/null ) &
  guard=$!
  wait "$pid"
  status=$?
  kill "$guard" 2>/dev/null
  wait "$guard" 2>/dev/null
  cat "$WORK/out"
  [ "$status" -eq 137 ] && echo "(killed after ${COMMAND_SECONDS}s)"
  return 0
}

# Appends one section to the report: the file is opened, written and closed.
section() {
  title=$1
  shift
  { printf '\n== %s\n' "$title"; limited "$@"; } >> "$REPORT" 2>&1
  sync
}

sh_section() { section "$1" sh -c "$2"; }

snapshot() {
  echo "Kindle Organizer diagnostics v3" > "$REPORT"
  sync
  section "date (UTC)" date -u
  section "uname" uname -a
  sh_section "cpu" "grep -iE 'model name|processor|features|architecture' /proc/cpuinfo | sort -u"
  section "firmware" cat /etc/prettyversion.txt
  sh_section "jailbreak" "ls -l /etc/upstart/kmc.conf; head -n 3 /mnt/us/documents/JAILBROKEN.txt"
  sh_section "tools" 'for t in sqlite3 curl lipc-get-prop lipc-wait-event lipc-probe setsid uniq timeout mntroot start stop initctl; do printf "%s: " "$t"; command -v "$t" || echo missing; done'
  section "sqlite3 version" sqlite3 -version
  sh_section "cc.db files" "ls -l /var/local/cc.db*"
  sh_section "cc.db snapshot" "sqlite3 -readonly /var/local/cc.db \".backup '$WORK/cc.db'\" && ls -l '$WORK/cc.db'"
  sh_section "Entries columns" "sqlite3 '$WORK/cc.db' 'PRAGMA table_info(Entries);' | cut -d'|' -f2,3"
  sh_section "Collections columns" "sqlite3 '$WORK/cc.db' 'PRAGMA table_info(Collections);' | cut -d'|' -f2,3"
  sh_section "Entries by type" "sqlite3 '$WORK/cc.db' 'SELECT p_type FROM Entries;' | sort | uniq -c"
  sh_section "memberships (rows in Collections)" "sqlite3 '$WORK/cc.db' 'SELECT count(*) FROM Collections;'"
  sh_section "items under /mnt/us/documents/" "sqlite3 '$WORK/cc.db' 'SELECT p_location FROM Entries;' | grep -c '^/mnt/us/documents/'"
  sh_section "the component's query form (hex, list mode)" "sqlite3 -init /dev/null -batch -noheader -list -separator '|' -readonly '$WORK/cc.db' 'SELECT hex(p_type), hex(p_uuid) FROM Entries LIMIT 1;' | cut -c1-40"
  rm -f "$WORK/cc.db"
  sh_section "session token" 'if [ -s /tmp/session_token ]; then echo "present, $(wc -c < /tmp/session_token) bytes"; else echo missing; fi'
  sh_section "listening on 9101 (catalog service)" "netstat -ltn | grep -E ':9101( |\$)' || echo 'not found (or netstat missing)'"
  section "driveModeState (raw)" lipc-get-prop com.lab126.volumd driveModeState
  section "volumd properties" lipc-probe -v com.lab126.volumd
  sh_section "mounts" "grep -E ' /mnt/(us|base-us) ' /proc/mounts"
  section "lipc-wait-event usage" lipc-wait-event
  section "free space (KiB)" df -k /var/local /mnt/us /tmp
  printf '\n== snapshot done\n' >> "$REPORT"
  sync
}

# /mnt/us is mounted read-write on the device, i.e. not exported over USB.
us_is_mine() {
  grep -qE ' /mnt/us [a-z0-9.]+ rw' /proc/mounts
}

watch_events() {
  lipc-wait-event -m "$1" "$2" > "$WORK/events-$3.txt" 2>&1 &
  echo $! >> "$WORK/pids"
}

# Everything goes to /tmp while the cable may be in: a file kept open on
# /mnt/us would stop the USB export.
record_usb() {
  : > "$WORK/pids"
  watch_events com.lab126.hal '*' hal-any
  watch_events com.lab126.hal 'usbPlugIn,usbPlugOut,usbConfigured,usbUnconfigured' hal-named
  watch_events com.lab126.volumd '*' volumd-any
  end=$(( $(date +%s) + WATCH_SECONDS ))
  while [ "$(date +%s)" -lt "$end" ]; do
    printf '%s %s | %s\n' "$(date -u +%H:%M:%S)" \
      "$(lipc-get-prop com.lab126.volumd driveModeState 2>&1 | tr '\n' ' ')" \
      "$(grep -E ' /mnt/us ' /proc/mounts | cut -d' ' -f3,4 | tr '\n' ' ')" >> "$WORK/drivemode.txt"
    sleep 2
  done
  kill $(cat "$WORK/pids") 2>/dev/null

  waited=0
  until us_is_mine || [ "$waited" -ge "$REMOUNT_WAIT_SECONDS" ]; do
    sleep 5
    waited=$(( waited + 5 ))
  done
  {
    printf '\n== USB events seen in %ss (waited %ss for /mnt/us)\n' "$WATCH_SECONDS" "$waited"
    for file in "$WORK"/events-*.txt; do echo "-- $(basename "$file")"; cat "$file"; done
    printf '\n== driveModeState | /mnt/us mount, every 2 s (changes only)\n'
    uniq -f1 "$WORK/drivemode.txt"
    printf '\n== done\n'
  } >> "$REPORT" 2>&1
  sync
  rm -rf "$WORK"
}

snapshot
record_usb
rm -f "$RUN"
exit 0

#!/usr/bin/env bash
# gfs2-rescue.sh v1.1 - take over a GFS2 volume left behind by a cluster (or appliance) that went
# down, check and repair it before the takeover, and record every step as evidence.
#
#   inspect  [--json]                     every GFS2 volume this host sees (multipath maps first)
#   collect  <dev> [--hash-under-mb N]    read-only: state, superblock backup, manifest, hashes,
#                                         qcow2 backing-chain report (mounts ro, lock_nolock)
#   check    <dev>                        read-only fsck.gfs2 -n, classified (clean/tier1/tier2/tier3)
#   repair   <dev> [--yes]                fsck.gfs2 -y for tier1/tier2 findings, re-check, then a
#                                         pre-takeover walk against the collect manifest + hashes
#   adopt    <dev> --locktable CLUSTER:FS rewrite the lock table; refuses unless check is clean
#            [--yes]
#   reuuid   <dev> [--yes]                give a duplicate copy (array snapshot exported to the
#                                         same hosts) a new filesystem UUID; data unchanged
#   verify   <mountpoint> <rundir>        after the new cluster mounts it: walk vs manifest + hashes
#   restore-sb <dev> <rundir>             write the saved superblock region back
#   rescan                                ask the SCSI/iSCSI layer for new LUNs (no multipath reload)
#   record   <step> <result> [detail]     add a step result to RUN's log and state.json
#
# Order: inspect -> (reuuid, only for a duplicate) -> collect -> check -> (repair) -> adopt
#        -> add the datastore in Morpheus, reformatting OFF (the plugin's Attach step) -> verify
# All output goes to <rundir>/log.md; machine-readable result of the last step in <rundir>/state.json.
# RUN=<dir> reuses a run folder (default /var/lib/gfs2-rescue/<timestamp>). --yes skips prompts
# (for automation; the caller is then responsible for the array snapshot).
set -uo pipefail
VERSION=1.1

RUN=${RUN:-/var/lib/gfs2-rescue/$(date +%Y%m%d-%H%M%S)}
die()   { echo "ERROR: $*" >&2; [[ -n ${LOG:-} ]] && printf '\n**ERROR: %s**\n' "$*" >>"$LOG"; state "${STEP:-?}" error "$*"; exit 1; }
note()  { echo "==> $*"; printf '\n**%s**\n' "$*" >>"$LOG"; }
state() { [[ -n ${RUN:-} && -d $RUN ]] || return 0
          printf '{"version":"%s","step":"%s","result":"%s","detail":"%s","time":"%s","host":"%s"}\n' \
            "$VERSION" "$1" "$2" "$(printf '%s' "${3:-}" | tr '"\n\\' "'  ")" "$(date -Is)" "$(hostname)" >"$RUN/state.json"; }
rec()   { local t=$1; shift
          printf '\n### %s\n```\n$ %s\n' "$t" "$*" >>"$LOG"; echo "--- $t"
          "$@" 2>&1 | tee -a "$LOG"; local rc=${PIPESTATUS[0]}
          printf '```\nexit %s\n' "$rc" >>"$LOG"; return "$rc"; }
need()  { for c in "$@"; do command -v "$c" >/dev/null || die "missing $c"; done; }
init()  { [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
          mkdir -p "$RUN"; chmod 700 "$RUN"; LOG=$RUN/log.md
          [[ -s $LOG ]] || printf '# GFS2 rescue log (v%s)\n\nhost: %s  started: %s  run: %s\n' "$VERSION" "$(hostname)" "$(date -Is)" "$RUN" >"$LOG"; }
lockdev() { exec 9>"/run/gfs2-rescue-$(basename "$1").lock"; flock -n 9 || die "another gfs2-rescue step is running on $1"; }
check_dev() { [[ -b $1 ]] || die "$1 is not a block device"
              [[ $1 == /dev/mapper/* ]] || echo "WARNING: $1 is not a multipath device; use /dev/mapper/<wwid> when the LUN has several paths"
              [[ $(type_of "$1") == gfs2 ]] || die "$1 is not gfs2 (superblock probe)"; }
locktable_of() { tunegfs2 -l "$1" | sed -n 's/^Lock table: *//p'; }
# Mount detection by device number, not UUID: an array snapshot exported to the same hosts has the
# same UUID as the original, and a UUID match would report the unmounted copy as mounted.
majmin_of()    { lsblk -dno MAJ:MIN "$1" 2>/dev/null | tr -d ' '; }
mounted_at()   { local mm; mm=$(majmin_of "$1"); [[ -n $mm ]] || return 0
                 findmnt -rn -t gfs2 -o MAJ:MIN,TARGET 2>/dev/null | awk -v m="$mm" '$1==m{print $2; exit}'; }
# Read-only local mount for collect/repair. GFS2 names its sysfs entry (/sys/fs/gfs2/<table>) after
# the lock table even with lock_nolock, so a copy whose original is mounted fails with EEXIST.
# locktable= overrides that name for this mount only (the superblock is not touched).
ro_table()     { echo "gfs2rescue:$(basename "$1" | tail -c 25)"; }
uuid_of()      { blkid -p -s UUID -o value "$1" 2>/dev/null; }   # -p: read the superblock, not a cache
type_of()      { blkid -p -s TYPE -o value "$1" 2>/dev/null; }   # GFS2 only: never trust udev's cached type
fsname_of()    { locktable_of "$1" | cut -d: -f2-; }
# The DLM lockspace is named after the fsname. A copy of a volume (snapshot, clone) shares the
# original's lock table, so the original's live lockspace also matches the copy's name. Prints the
# OTHER device here that has the same lock table and is mounted, i.e. the real owner of the lockspace.
lockspace_owner() {
  local dev=$1 lt p; lt=$(locktable_of "$dev"); [[ -n $lt ]] || return 1
  while read -r p; do
    [[ $p == "$dev" ]] && continue
    [[ $(type_of "$p") == gfs2 && -n $(mounted_at "$p") ]] || continue
    [[ $(locktable_of "$p") == "$lt" ]] && { echo "$p"; return 0; }
  done < <(lsblk -rnpo PATH,FSTYPE 2>/dev/null | awk '$2=="gfs2"{print $1}' | sort -u)
  return 1; }
not_in_use() {  # refuse if mounted here, or its lockspace is live here and belongs to nothing else
  local dev=$1 fs owner; fs=$(fsname_of "$dev")
  [[ -n $(mounted_at "$dev") ]] && die "$dev is mounted on this host"
  if [[ -n $fs ]] && dlm_tool ls 2>/dev/null | awk '/^name/{print $2}' | grep -qx "$fs"; then
    owner=$(lockspace_owner "$dev") || die "DLM lockspace $fs is live on this host"
    echo "DLM lockspace $fs belongs to $owner (mounted at $(mounted_at "$owner")), not to $dev"
  fi
  return 0; }
confirm() { [[ ${YES:-0} -eq 1 ]] && return 0; local a; read -rp "$1 type $2: " a; [[ $a == "$2" ]] || die "aborted"; }

# --- fsck classification --------------------------------------------------------------------
#  clean  no findings
#  tier1  data blocks marked used but unowned, rgrp free counts, statfs: unclean-shutdown leftovers
#  tier2  inode blocks marked used but unowned, rgrp inode counts: repair can free an inode a
#         directory entry still names - repair only with a manifest and verify afterwards
#  tier3  anything in passes 1b-4, or level-1 rgrp check not passed: stop, human review on a clone
# fsck.gfs2 redraws progress counters in place with \r and may colour its output; a terminal only
# shows the last redraw, so the raw file holds fragments a person never sees. Grade what is seen:
# per line the last \r segment that is not blank, no escape codes, trimmed, blank lines dropped,
# pure progress counters ("N percent complete." or N%) dropped. A message written after a redraw is the last
# segment and is kept, so a finding is never lost; anything unrecognised still counts.
fsck_seen() {
  sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' "$1" | awk -F'\r' '{
    l=""; for (i=NF; i>0; i--) if ($i !~ /^[ \t]*$/) { l=$i; break }
    gsub(/^[ \t]+|[ \t]+$/, "", l)
    if (l != "" && l !~ /[0-9]+%$/ && l !~ /^[0-9]+ percent complete\.?$/) print l }'; }
classify_fsck() {
  local f; f=$(mktemp); fsck_seen "$1" >"$f"
  _classify "$f"; local r=$?; rm -f "$f"; return $r; }
_classify() {
  local f=$1
  grep -q '(level 1 passed)' "$f" || { echo tier3; return; }
  local late; late=$(sed -n '/^Starting pass1b/,$p' "$f" | grep -vE '^(Starting |pass[0-9a-z]+ completed|check_statfs completed|The statfs file|Current statfs|Calculated statfs|blocks: |free: |dinodes: |fsck.gfs2 complete|Writing changes|$)')
  [[ -n $late ]] && { echo tier3; return; }
  local p1; p1=$(sed -n '/^Starting pass1$/,/^Starting pass1b/p' "$f")
  grep -qE 'bitmap says [23] |Inode count inconsistent' <<<"$p1" && { echo tier2; return; }
  grep -qE 'bitmap says 1 |free count inconsistent' <<<"$p1" && { echo tier1; return; }
  grep -q 'The statfs file is wrong' "$f" && { echo tier1; return; }
  echo clean; }
explain_tier() { case $1 in
  clean) echo "no findings";;
  tier1) echo "accounting leftovers only (unowned data blocks / free counts / statfs) - safe to repair: $0 repair <dev>";;
  tier2) echo "inode accounting findings - repair can orphan a directory entry; repair runs a manifest walk afterwards and lists anything unreadable: $0 repair <dev>";;
  tier3) echo "structural findings (passes 1b-4 or rgrp index) - STOP: repair only on a clone of the array snapshot, with human review";;
esac; }
run_fsck_n() {  # run_fsck_n dev outfile -> prints tier
  rec "fsck.gfs2 -n (read-only)" bash -c "fsck.gfs2 -n '$1' >'$2' 2>&1; rc=\$?; cat '$2'; exit \$rc" >/dev/null
  classify_fsck "$2"; }

# --- walk a mounted tree against the collect manifest ---------------------------------------
walk_compare() {  # walk_compare mountpoint label -> sets WALK_MISS WALK_BAD WALK_UNREAD
  local mp=$1 label=$2
  ( cd "$mp" && find . -xdev -printf '%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%p\n' 2>"$RUN/walk-$label.err" | sort -t$'\t' -k4 ) >"$RUN/manifest-$label.tsv"
  local key='{print $1"\t"$2"\t"$4}'
  comm -23 <(awk -F'\t' "$key" "$RUN/manifest-before.tsv" | sort) <(awk -F'\t' "$key" "$RUN/manifest-$label.tsv" | sort) >"$RUN/missing-$label.txt"
  # entries listed by readdir whose inode cannot be read (ESTALE/EIO) show up as find errors
  grep -E 'Stale file handle|Input/output error|No such file' "$RUN/walk-$label.err" >"$RUN/unreadable-$label.txt" || true
  : >"$RUN/hashfail-$label.txt"
  [[ -s $RUN/sha256-before.txt ]] && ( cd "$mp" && sha256sum --quiet -c "$RUN/sha256-before.txt" 2>&1 | grep -E 'FAILED|No such|Stale|Input/output' ) >"$RUN/hashfail-$label.txt" || true
  WALK_MISS=$(wc -l <"$RUN/missing-$label.txt"); WALK_UNREAD=$(wc -l <"$RUN/unreadable-$label.txt"); WALK_BAD=$(wc -l <"$RUN/hashfail-$label.txt")
  rec "missing or changed vs manifest (type, size, path)" head -100 "$RUN/missing-$label.txt"
  rec "unreadable entries" cat "$RUN/unreadable-$label.txt"
  rec "hash failures" cat "$RUN/hashfail-$label.txt"
  note "walk[$label]: missing/changed=$WALK_MISS  unreadable=$WALK_UNREAD  hash failures=$WALK_BAD"; }

# --- commands ---------------------------------------------------------------------------------
inspect() {
  [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
  local json=0; [[ ${1:-} == --json ]] && json=1
  local hc; hc=$(cat /sys/kernel/config/dlm/cluster/cluster_name 2>/dev/null || echo "")
  local lsp; lsp=$(dlm_tool ls 2>/dev/null | awk '/^name/{print $2}' | tr '\n' ' ')
  local first=1 path fstype type size uuid
  [[ $json -eq 1 ]] && printf '{"version":"%s","host":"%s","hostCluster":"%s","volumes":[' "$VERSION" "$(hostname)" "$hc"
  while read -r path fstype type size uuid; do
    [[ $type == disk || $type == part ]] && lsblk -rno TYPE "$path" | grep -q mpath && continue
    [[ -b $path ]] || continue                            # the path must be a real block device on this host
    [[ $(type_of "$path") == gfs2 ]] || continue          # udev listed it as gfs2; the superblock must agree
    local sb lt lp fs nj mnt live
    sb=$(tunegfs2 -l "$path" 2>/dev/null)
    lt=$(sed -n 's/^Lock table: *//p' <<<"$sb"); lp=$(sed -n 's/^Lock protocol: *//p' <<<"$sb"); fs=${lt#*:}
    nj=$(gfs2_edit -p jindex "$path" 2>/dev/null | grep -Eo 'journal[0-9]+' | sort -u | wc -l)
    uuid=$(uuid_of "$path"); mnt=$(mounted_at "$path")
    live=false; [[ " $lsp " == *" $fs "* ]] && live=true
    if [[ $json -eq 1 ]]; then
      [[ $first -eq 1 ]] || printf ','; first=0
      printf '{"fsType":"gfs2","device":"%s","wwid":"%s","type":"%s","size":"%s","uuid":"%s","lockProto":"%s","lockTable":"%s","fsName":"%s","journals":%s,"mountedAt":"%s","lockspaceLive":%s,"matchesHostCluster":%s,"suggestedLockTable":"%s"}' \
        "$path" "${path#/dev/mapper/}" "$type" "$size" "$uuid" "$lp" "$lt" "$fs" "${nj:-0}" "$mnt" "$live" \
        "$([[ -n $hc && ${lt%%:*} == "$hc" ]] && echo true || echo false)" "${hc:+$hc:$fs}"
    else
      printf '%-50s %-6s %-6s lock=%-32s journals=%-3s mounted=%-20s lockspace=%s\n' "$path" "$type" "$size" "$lt" "$nj" "${mnt:--}" "$live"
    fi
  done < <(lsblk -rnpo PATH,FSTYPE,TYPE,SIZE,UUID | awk '$2=="gfs2" && !seen[$1]++')
  [[ $json -eq 1 ]] && printf ']}\n' || echo "host cluster: ${hc:-none}"; }

collect() {
  STEP=collect; local dev=${1:?device}; shift; local hashmb=0
  while [[ $# -gt 0 ]]; do case $1 in --hash-under-mb) hashmb=$2; shift 2;; *) die "unknown $1";; esac; done
  init; need tunegfs2 gfs2_edit qemu-img; check_dev "$dev"; lockdev "$dev"; not_in_use "$dev"
  note "collect $dev"
  rec "multipath" multipath -ll
  rec "block device" lsblk -f "$dev"
  rec "superblock" tunegfs2 -l "$dev"
  rec "journals" bash -c "gfs2_edit -p jindex '$dev' | grep -Eo 'journal[0-9]+' | sort -u | wc -l"
  rec "this host DLM cluster" bash -c 'cat /sys/kernel/config/dlm/cluster/cluster_name 2>/dev/null || echo none'
  rec "DLM lockspaces" bash -c 'dlm_tool ls 2>/dev/null || echo none'
  rec "superblock backup (first 128 KiB)" bash -c "dd if='$dev' of='$RUN/sb-first-128k.img' bs=4096 count=32 status=none && sha256sum '$RUN/sb-first-128k.img'"
  local mnt=$RUN/mnt; mkdir -p "$mnt"
  rec "mount read-only, local locking" mount -t gfs2 -o "ro,lockproto=lock_nolock,locktable=$(ro_table "$dev")" "$dev" "$mnt" || die "read-only mount failed (see log)"
  rec "usage" bash -c "df -h '$mnt'; du -sh '$mnt'/* 2>/dev/null | sort -h"
  ( cd "$mnt" && find . -xdev -printf '%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%p\n' 2>"$RUN/walk-before.err" | sort -t$'\t' -k4 ) >"$RUN/manifest-before.tsv"
  [[ -s $RUN/walk-before.err ]] && rec "entries already unreadable before any change" cat "$RUN/walk-before.err"
  uuid_of "$dev" >"$RUN/fs-uuid"   # lets a run follow the filesystem if the LUN's WWID changes
  note "manifest: $(wc -l <"$RUN/manifest-before.tsv") entries"
  : >"$RUN/qcow2-chains.txt"
  while IFS= read -r f; do
    [[ $(head -c 4 "$mnt/$f" 2>/dev/null | od -An -tx1 | tr -d ' \n') == 514649fb ]] || continue
    { echo "== $f"; qemu-img info -U "$mnt/$f" 2>&1 | grep -E 'virtual size|disk size|backing file'; } >>"$RUN/qcow2-chains.txt"
  done < <(awk -F'\t' '$1=="f"{print $4}' "$RUN/manifest-before.tsv")
  note "qcow2 images: $(grep -c '^== ' "$RUN/qcow2-chains.txt"); with a backing file: $(grep -c 'backing file:' "$RUN/qcow2-chains.txt")"
  grep -B3 'backing file:' "$RUN/qcow2-chains.txt" | tee -a "$LOG" || true
  if [[ $hashmb -gt 0 ]]; then
    ( cd "$mnt" && find . -xdev -type f -size -"${hashmb}"M -print0 | sort -z | xargs -0 -r sha256sum ) >"$RUN/sha256-before.txt"
    note "hashed $(wc -l <"$RUN/sha256-before.txt") files under ${hashmb} MiB"
  fi
  rec "unmount" umount "$mnt"
  state collect ok "$(wc -l <"$RUN/manifest-before.tsv") entries"
  note "collect done: $RUN   next: $0 check $dev  (RUN=$RUN)"; }

check() {
  STEP=check; local dev=${1:?device}
  init; need fsck.gfs2; check_dev "$dev"; lockdev "$dev"; not_in_use "$dev"
  note "check $dev"
  local tier; tier=$(run_fsck_n "$dev" "$RUN/fsck-n.txt")
  note "fsck result: $tier - $(explain_tier "$tier")"
  state check "$tier" "$(explain_tier "$tier")"
  [[ $tier == clean ]]; }

repair() {
  STEP=repair; local dev=${1:?device}; shift
  while [[ $# -gt 0 ]]; do case $1 in --yes) YES=1; shift;; *) die "unknown $1";; esac; done
  init; need fsck.gfs2; check_dev "$dev"; lockdev "$dev"; not_in_use "$dev"
  [[ -s $RUN/manifest-before.tsv && -s $RUN/sb-first-128k.img ]] || die "no collect data in $RUN - run collect first (repair needs the manifest to check its own result)"
  note "repair $dev"
  local tier; tier=$(run_fsck_n "$dev" "$RUN/fsck-n.txt")
  note "fsck before repair: $tier - $(explain_tier "$tier")"
  [[ $tier == clean ]] && { state repair clean "nothing to repair"; note "nothing to repair"; return 0; }
  [[ $tier == tier3 ]] && die "$(explain_tier tier3)"
  confirm "Array snapshot taken? This writes to the filesystem." REPAIR
  rec "fsck.gfs2 -y (repair)" bash -c "fsck.gfs2 -y '$dev' >'$RUN/fsck-y.txt' 2>&1; rc=\$?; cat '$RUN/fsck-y.txt'; exit \$rc"
  tier=$(run_fsck_n "$dev" "$RUN/fsck-n-after.txt")
  [[ $tier == clean ]] || die "re-check after repair is $tier - $(explain_tier "$tier")"
  note "re-check clean; walking the repaired filesystem against the collect manifest (before takeover)"
  local mnt=$RUN/mnt; mkdir -p "$mnt"
  rec "mount read-only, local locking" mount -t gfs2 -o "ro,lockproto=lock_nolock,locktable=$(ro_table "$dev")" "$dev" "$mnt" || die "read-only mount after repair failed"
  walk_compare "$mnt" after-repair
  rec "unmount" umount "$mnt"
  if [[ $WALK_MISS -eq 0 && $WALK_UNREAD -eq 0 && $WALK_BAD -eq 0 ]]; then
    state repair ok "repaired and verified"; note "repair verified - next: $0 adopt $dev --locktable <cluster>:<fsname>"
  else
    state repair issues "missing=$WALK_MISS unreadable=$WALK_UNREAD hashfail=$WALK_BAD"
    note "repair left entries that cannot be read (lists above, files in $RUN). Restore them from another copy if they matter, or accept the loss; adopt will proceed only with --allow-unreadable"
    exit 3
  fi; }

adopt() {
  STEP=adopt; local dev=${1:?device}; shift; local lt="" allow_unread=0
  while [[ $# -gt 0 ]]; do case $1 in --locktable) lt=$2; shift 2;; --yes) YES=1; shift;; --allow-unreadable) allow_unread=1; shift;; *) die "unknown $1";; esac; done
  [[ $lt == *:* ]] || die "--locktable CLUSTER:FSNAME required (Morpheus shows it in the mismatch message; inspect shows the suggestion)"
  local cl=${lt%%:*} fs=${lt#*:}
  [[ -n $cl && ${#cl} -le 32 && -n $fs && ${#fs} -le 30 ]] || die "cluster name 1-32 chars, fsname 1-30 chars"
  init; need tunegfs2 fsck.gfs2 gfs2_edit; check_dev "$dev"; lockdev "$dev"; not_in_use "$dev"
  [[ -s $RUN/manifest-before.tsv ]] || echo "WARNING: no collect data in $RUN - verify will have nothing to compare against"
  if [[ -s $RUN/state.json ]] && grep -q '"step":"repair","result":"issues"' "$RUN/state.json" && [[ $allow_unread -eq 0 ]]; then
    die "the repair in this run left unreadable entries - re-run with --allow-unreadable once you accept them"; fi
  note "adopt $dev -> $lt"
  rec "superblock before" tunegfs2 -l "$dev"
  confirm "Array snapshot of this LUN taken, and no old-cluster host can reach it?" SNAPSHOT
  local tier; tier=$(run_fsck_n "$dev" "$RUN/fsck-n-adopt.txt")
  [[ $tier == clean ]] || { state adopt blocked "$tier"; die "fsck is $tier - $(explain_tier "$tier")"; }
  [[ -s $RUN/sb-first-128k.img ]] || rec "superblock backup" dd if="$dev" of="$RUN/sb-first-128k.img" bs=4096 count=32 status=none
  rec "set lock protocol" tunegfs2 -o lockproto=lock_dlm "$dev" || die "tunegfs2 failed"
  rec "set lock table" tunegfs2 -o locktable="$lt" "$dev" || die "tunegfs2 failed"
  rec "superblock after" tunegfs2 -l "$dev"
  [[ $(locktable_of "$dev") == "$lt" ]] || die "lock table did not change"
  local nj; nj=$(gfs2_edit -p jindex "$dev" 2>/dev/null | grep -Eo 'journal[0-9]+' | sort -u | wc -l)
  state adopt ok "$lt; journals=$nj"
  note "adopt done ($nj journals; need one per host - gfs2_jadd after mounting if short)"
  note "next: Attach on the GFS2 Storage tab (from a shell: add the datastore in Morpheus on $dev with Allow Reformatting UNCHECKED), then Verify ($0 verify <mountpoint> $RUN)"; }

verify() {
  STEP=verify; local mp=${1:?mountpoint} run=${2:?rundir}; RUN=$run; init
  [[ -s $RUN/manifest-before.tsv ]] || die "no manifest-before.tsv in $RUN"
  findmnt -rn -t gfs2 "$mp" >/dev/null || die "$mp is not a mounted gfs2"
  note "verify $mp"
  rec "mount" findmnt -t gfs2 "$mp"
  walk_compare "$mp" after
  if [[ $WALK_MISS -eq 0 && $WALK_UNREAD -eq 0 && $WALK_BAD -eq 0 ]]; then
    state verify ok "all entries present and unchanged"; note "VERIFIED: everything recorded before the takeover is present and unchanged"
  else
    state verify issues "missing=$WALK_MISS unreadable=$WALK_UNREAD hashfail=$WALK_BAD"
    note "CHECK the lists above. An unreadable entry ('Stale file handle') is a directory entry naming an invalid inode: do not delete it while mounted; clear it with an offline fsck.gfs2 -y"
    exit 3
  fi; }

reuuid() {
  STEP=reuuid; local dev=${1:?device}; shift
  while [[ $# -gt 0 ]]; do case $1 in --yes) YES=1; shift;; *) die "unknown $1";; esac; done
  init; need tunegfs2 uuidgen blkid; check_dev "$dev"; lockdev "$dev"
  [[ -n $(mounted_at "$dev") ]] && die "$dev is mounted on this host"
  local old fs others p
  old=$(uuid_of "$dev"); fs=$(fsname_of "$dev")
  [[ -n $old ]] || die "cannot read the filesystem UUID of $dev"
  others=$(lsblk -rnpo PATH,FSTYPE,TYPE | awk '$2=="gfs2"{print $1}' | sort -u | while read -r p; do
             [[ $p == "$dev" ]] && continue
             [[ $(type_of "$p") == gfs2 ]] || continue
             lsblk -rno TYPE "$p" | grep -q mpath && [[ $p != /dev/mapper/* ]] && continue
             [[ $(uuid_of "$p") == "$old" ]] && echo "$p"; done)
  [[ -n $others ]] || echo "WARNING: no other device on this host carries UUID $old"
  # The DLM lockspace is named after the fsname, which the copy shares with the original. A live
  # lockspace is only acceptable when the original is the one mounted here.
  if [[ -n $fs ]] && dlm_tool ls 2>/dev/null | awk '/^name/{print $2}' | grep -qx "$fs"; then
    local owner=""; for p in $others; do [[ -n $(mounted_at "$p") ]] && owner=$p; done
    [[ -n $owner ]] || die "DLM lockspace $fs is live on this host and no other device with UUID $old is mounted here"
    echo "lockspace $fs belongs to $owner (mounted at $(mounted_at "$owner"))"
  fi
  note "reuuid $dev (UUID $old, also on: ${others:-no other device on this host})"
  rec "superblock before" tunegfs2 -l "$dev"
  confirm "Give $dev a new filesystem UUID? Data and lock table are unchanged." REUUID
  rec "superblock backup (first 128 KiB)" bash -c "dd if='$dev' of='$RUN/sb-before-reuuid-128k.img' bs=4096 count=32 status=none && sha256sum '$RUN/sb-before-reuuid-128k.img'"
  local new; new=$(uuidgen)
  rec "set new UUID" tunegfs2 -U "$new" "$dev" || die "tunegfs2 -U failed"
  rec "superblock after" tunegfs2 -l "$dev"
  [[ $(uuid_of "$dev") == "$new" ]] || die "UUID did not change"
  udevadm trigger --action=change "$dev" 2>/dev/null; udevadm settle -t 30 2>/dev/null || true
  state reuuid ok "$old -> $new"
  note "reuuid done: $old -> $new. Other hosts read the UUID from the superblock on their next inspect. Next: collect"; }

rescan() {
  [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
  local h n=0
  for h in /sys/class/scsi_host/host*/scan; do [[ -w $h ]] && echo '- - -' >"$h" && n=$((n+1)); done
  command -v iscsiadm >/dev/null && iscsiadm -m session --rescan >/dev/null 2>&1
  udevadm settle -t 60 2>/dev/null || true
  echo "GR-RESCAN-OK scsi_hosts=$n"; }

record() {
  local step=${1:?step} result=${2:?result} detail=${3:-}; STEP=$step
  init; note "$step -> $result${detail:+: $detail}"; state "$step" "$result" "$detail"; }

restore_sb() {
  STEP=restore-sb; local dev=${1:?device} run=${2:?rundir}; RUN=$run; init
  [[ -s $RUN/sb-first-128k.img ]] || die "no superblock backup in $RUN"
  check_dev "$dev"; lockdev "$dev"; not_in_use "$dev"
  confirm "Write $RUN/sb-first-128k.img back to $dev?" RESTORE
  rec "restore superblock" dd if="$RUN/sb-first-128k.img" of="$dev" bs=4096 count=32 conv=notrunc,fsync status=none
  rec "superblock now" tunegfs2 -l "$dev"
  state restore-sb ok "superblock restored"; }

case ${1:-} in
  inspect) shift; inspect "$@";;
  collect) shift; collect "$@";;
  check)   shift; check "$@";;
  repair)  shift; repair "$@";;
  adopt)   shift; adopt "$@";;
  verify)  shift; verify "$@";;
  reuuid)  shift; reuuid "$@";;
  rescan)  shift; rescan "$@";;
  record)  shift; record "$@";;
  restore-sb) shift; restore_sb "$@";;
  --version) echo "$VERSION";;
  *) sed -n '2,27p' "$0"; exit 1;;
esac

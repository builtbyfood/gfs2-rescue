#!/usr/bin/env bash
# gfs2-demo-orphan.sh - make a small LUN look like GFS2 storage left behind by a cluster that no
# longer exists, so the takeover (gfs2-rescue.sh) can be demonstrated end to end.
#
#   prepare <dev> [--old-cluster NAME] [--fsname NAME] [--journals N] [--no-data] [--yes]
#       - if it is gfs2: only rewrite the lock table to <old-cluster>:<fsname> (data kept)
#       - if it is completely blank (no filesystem signature at all): mkfs.gfs2 with that lock table
#       - anything else (another filesystem, LVM, partitions): refused - this tool never reformats
#       - unless --no-data: mount it locally (lock_nolock) and write demo content:
#           demo-vm/demo-vm.xml, demo-vm/disk-0.qcow2 (base, 1 GiB virtual, 64 MiB written),
#           demo-vm/disk-0.qcow2-snap (overlay whose backing path points at the OLD cluster's
#           datastore mount, /mnt/<random-uuid>/demo-vm/disk-0.qcow2 - shows up as a broken
#           reference in the rescue report), notes.txt, random.bin (32 MiB) + SHA256SUMS
#       - writes /var/lib/gfs2-demo/<wwid>.info with what it did
#   show <dev>      print the current lock table and the recorded demo info
#
# Defaults: --old-cluster = random 14-char name (Morpheus style), --fsname demo_bay, --journals 32
# (what Morpheus creates; journals are only used when formatting - an existing GFS2 keeps its own).
# Run on ONE host of the cluster, with the LUN unmounted everywhere (delete the datastore in
# Morpheus first). Afterwards the add-datastore dialog shows the lock table mismatch, and
# gfs2-rescue.sh inspect/collect/check/adopt/verify takes it over.
set -uo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"

randname() { tr -dc 'a-z0-9' </dev/urandom | head -c 14; }
in_use() {
  local dev=$1 uuid fs
  uuid=$(blkid -p -s UUID -o value "$dev" 2>/dev/null || true)
  findmnt -rn -S "$dev" >/dev/null 2>&1 && return 0
  [[ -n $uuid ]] && findmnt -rn -S "UUID=$uuid" >/dev/null 2>&1 && return 0
  if [[ $(blkid -p -s TYPE -o value "$dev" 2>/dev/null) == gfs2 ]]; then
    fs=$(tunegfs2 -l "$dev" | sed -n 's/^Lock table: *//p' | cut -d: -f2-)
    [[ -n $fs ]] && dlm_tool ls 2>/dev/null | awk '/^name/{print $2}' | grep -qx "$fs" && return 0
  fi
  return 1
}

prepare() {
  local dev=${1:?device}; shift
  local old="" fs=demo_bay nj=32 data=1 yes=0
  while [[ $# -gt 0 ]]; do case $1 in
    --old-cluster) old=$2; shift 2;; --fsname) fs=$2; shift 2;; --journals) nj=$2; shift 2;;
    --no-data) data=0; shift;; --yes) yes=1; shift;; *) die "unknown $1";; esac; done
  [[ -b $dev ]] || die "$dev is not a block device"
  [[ $dev == /dev/mapper/* ]] || echo "WARNING: use the multipath device /dev/mapper/<wwid> if the LUN has several paths"
  for c in mkfs.gfs2 tunegfs2 qemu-img; do command -v $c >/dev/null || die "missing $c"; done
  in_use "$dev" && die "$dev is mounted or its lockspace is live on this host - delete the datastore in Morpheus and check every host"
  [[ -n $old ]] || old=$(randname)
  [[ ${#old} -le 32 && ${#fs} -le 30 ]] || die "cluster name <=32, fsname <=30 chars"
  local here; here=$(cat /sys/kernel/config/dlm/cluster/cluster_name 2>/dev/null || echo "")
  [[ $old == "$here" ]] && die "--old-cluster must differ from this cluster ($here)"
  local cur; cur=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || echo none)
  echo "device:        $dev ($(lsblk -dno SIZE "$dev"))"
  echo "current type:  $cur"
  echo "this cluster:  ${here:-unknown}"
  echo "orphan as:     $old:$fs"
  local a
  if [[ $cur != gfs2 && $cur != none ]] || lsblk -no NAME "$dev" | sed 1d | grep -q .; then
    die "$dev holds $cur data or partitions - refusing; only a GFS2 volume or a completely blank LUN is accepted"
  fi
  if [[ $cur == none ]]; then
    if [[ $yes -eq 0 ]]; then read -rp "$dev is blank - create a GFS2 filesystem on it? type FORMAT: " a; [[ $a == FORMAT ]] || die "aborted"; fi
    mkfs.gfs2 -O -p lock_dlm -t "$old:$fs" -j "$nj" "$dev" || die "mkfs.gfs2 failed"
  else
    if [[ $yes -eq 0 ]]; then read -rp "Rewrite lock table of $dev to $old:$fs? type ORPHAN: " a; [[ $a == ORPHAN ]] || die "aborted"; fi
    tunegfs2 -o lockproto=lock_dlm "$dev" && tunegfs2 -o locktable="$old:$fs" "$dev" || die "tunegfs2 failed"
  fi

  local olduuid; olduuid=$(cat /proc/sys/kernel/random/uuid)
  if [[ $data -eq 1 ]]; then
    local mnt; mnt=$(mktemp -d /tmp/gfs2-demo.XXXX)
    mount -t gfs2 -o lockproto=lock_nolock "$dev" "$mnt" || die "local mount failed"
    mkdir -p "$mnt/demo-vm"
    cat >"$mnt/notes.txt" <<NOTE
Demo volume for the GFS2 takeover.
Created $(date -Is) on $(hostname) with lock table $old:$fs.
The "previous cluster" datastore mount was /mnt/$olduuid.
NOTE
    cat >"$mnt/demo-vm/demo-vm.xml" <<XML
<domain type='kvm'>
  <name>demo-vm</name>
  <memory unit='MiB'>512</memory>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/mnt/$olduuid/demo-vm/disk-0.qcow2-snap'/>
      <target dev='vda' bus='virtio'/>
    </disk>
  </devices>
</domain>
XML
    qemu-img create -q -f qcow2 "$mnt/demo-vm/disk-0.qcow2" 1G
    # write 64 MiB into the base so it holds real data
    if command -v qemu-io >/dev/null; then qemu-io -f qcow2 -c 'write -P 0x5a 0 64M' "$mnt/demo-vm/disk-0.qcow2" >/dev/null
    fi
    # overlay whose backing path is the OLD cluster's mount - a broken reference after takeover
    qemu-img create -q -f qcow2 -F qcow2 -u -b "/mnt/$olduuid/demo-vm/disk-0.qcow2" "$mnt/demo-vm/disk-0.qcow2-snap" 1G
    dd if=/dev/urandom of="$mnt/random.bin" bs=1M count=32 status=none
    ( cd "$mnt" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum ) >"$mnt/SHA256SUMS"
    sync; umount "$mnt"; rmdir "$mnt"
  fi

  mkdir -p /var/lib/gfs2-demo
  local info=/var/lib/gfs2-demo/$(basename "$dev").info
  cat >"$info" <<INFO
device=$dev
size=$(lsblk -dno SIZE "$dev")
uuid=$(blkid -p -s UUID -o value "$dev")
orphan_locktable=$old:$fs
this_cluster=$here
expected_new_locktable=$here:$fs
old_datastore_mount=/mnt/$olduuid
demo_data=$([[ $data -eq 1 ]] && echo yes || echo no)
prepared=$(date -Is) on $(hostname)
INFO
  echo
  tunegfs2 -l "$dev" | grep -E 'Lock (table|protocol)|UUID'
  echo
  echo "Recorded in $info"
  echo "Next: Infrastructure -> Clusters -> (cluster) -> GFS2 Storage: Collect, Check, Adopt, Attach, Verify."
  echo "      (shell: gfs2-rescue.sh inspect / collect $dev --hash-under-mb 64 / check / adopt --locktable $here:$fs / verify)"
}

show() {
  local dev=${1:?device}
  tunegfs2 -l "$dev" | grep -E 'Lock (table|protocol)|UUID'
  local info=/var/lib/gfs2-demo/$(basename "$dev").info
  [[ -f $info ]] && { echo; cat "$info"; }
}

case ${1:-} in
  prepare) shift; prepare "$@";;
  show)    shift; show "$@";;
  *) sed -n '2,23p' "$0"; exit 1;;
esac

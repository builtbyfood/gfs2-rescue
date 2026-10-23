# Changelog

## Unreleased
- Morpheus 9.0.x support: `-PmorpheusTarget=9.0` builds a jar for 9.0.x
  (`build-9.0/libs/morpheus-gfs2-rescue-<version>-9.0-all.jar`) with plugin-api 1.4.1, Groovy 3.0.9
  and Java 11 bytecode, from the same source. The default build for 9.1 is unchanged. The 9.0
  build uses a Java 17 toolchain, which Gradle downloads if none is installed. Tested on
  Morpheus 9.0.1. No code changes.

## 0.1.22
- Documentation: screenshots redacted. Cluster and DLM names, host names, LUN WWIDs, non-demo
  datastore names, the appliance address and unrelated credentials are covered with solid boxes;
  the credential list is cropped to the plugin's own credential. The example credential in the
  settings page is generic. The shot list says how to redact new screenshots. No code changes.

## 0.1.21
- Documentation: the snapshot page now shows the full copy takeover with 8 screenshots (Re-UUID,
  Collect, Check, Adopt name, Adopt ok, Attach progress twice, Verify), and notes that an array may
  present a copy under a new WWID. The cluster-box shot is cropped to the box itself. No code changes.

## 0.1.20
- A run follows the filesystem when the array gives its LUN a new WWID. Seen with an array clone:
  after the takeover the same filesystem came back under a new WWID, so the tab found no run and
  Verify was not offered. Now, when a LUN has no run on the chosen host, the tab continues the
  newest run there that has a Collect manifest for the same filesystem UUID, links it to the new
  WWID and notes the change in the run's log; the page says so. Never for duplicate UUIDs.
- Collect records the filesystem UUID in the run folder (`fs-uuid`). Existing runs are matched from
  the superblock lines already in their log.
- Script v1.1.

## 0.1.19
- Attach now requires the device on every host of the cluster, and names any host that does not
  have it (or could not be checked). Morpheus checks the device on every host when it creates the
  datastore; before, Attach let it try and fail with "Device /dev/mapper/... not found on <host>",
  leaving an offline datastore record.
- The host script lists a device only if its path is a real block device (`test -b`), so a host
  with a stale or broken `/dev/mapper` entry no longer counts as seeing the volume.
- Troubleshooting: the Morpheus "Unable to prepare datastore" error and how to check multipath.
- Script v1.0.

## 0.1.18
- Check grading also ignores fsck.gfs2's own progress counter ("N percent complete.") when it is
  the last thing on a line, not only mid-line. Confirmed against the raw output of the cloned LUN:
  `\r0 percent complete.\rpass2 completed in 0.388s` now grades clean, and findings after a
  redraw still grade tier1/tier3.
- Script v0.9.

## 0.1.17
- Fix: Check could grade a clean filesystem tier3. fsck.gfs2 redraws its progress counters in place
  with carriage returns, so the saved output held fragments a terminal never shows, and the
  classifier counted them as unrecognised findings after pass 1b. Grading now uses what a terminal
  shows: the last segment of each redrawn line, without colour codes, trimmed, with pure progress
  counters dropped. A message written after a redraw is still graded. Found on a cloned LUN whose
  fsck output was clean but graded tier3.
- Script v0.8.

## 0.1.16
- Fix: Collect (and Repair's walk) on a copy whose original is mounted failed with "mount() failed:
  File exists". GFS2 names each mount's sysfs entry after the lock table, even for a local
  lock_nolock mount, so the copy clashed with the mounted original. The read-only mounts now pass
  `locktable=gfs2rescue:<wwid tail>`, which renames that entry for the one mount and leaves the
  superblock untouched.
- Script v0.7.

## 0.1.15
- Fix: after a Re-UUID, Collect (and Check, Repair, Adopt) on the copy failed with "DLM lockspace
  <name> is live on this host". The copy still shares the original's lock table, so the original's
  live lockspace matched the copy's name. The host script now credits a live lockspace to the
  mounted device with the same lock table, as the server already did, and refuses only when no
  such device is mounted on the host. Found on the first live Re-UUID run (which itself succeeded).
- Script v0.6.

## 0.1.14
- Documentation: the duplicate-UUID screenshot is in; all 14 screenshots are now embedded. No code
  changes.

## 0.1.13
- Fix: on a duplicate-UUID volume, the reasons under the greyed-out steps ran into the next column
  (a long device path has no break points). Reasons now wrap anywhere, and the duplicate reason is
  short, since the warning at the top already names the pair. Verified on a real cloned LUN: the
  clone showed no mount and no live lockspace, and Re-UUID was the only step offered.

## 0.1.12
- Documentation: screenshots embedded from `docs/images/` (13 of 14; the duplicate-UUID shot is
  still a placeholder). No code changes.

## 0.1.11
- Fix: every step was refused with "not a GFS2 filesystem: this tool only works on GFS2" (0.1.8
  regression). The merged volume record dropped the probed filesystem type, so the GFS2 check
  repeated at step start always failed. The type is now kept on the merged record, with a test.

## 0.1.10
- Documentation: rewritten around what the tool is for (cluster to cluster migration, cluster
  rebuilds, a lost appliance, disaster recovery, restoring VMs from a snapshot), with no
  environment-specific examples. Screenshot placeholders through the walkthrough, with a capture
  list in `docs/images/SHOTLIST.md`. Code comments no longer name specific volumes. No code changes.

## 0.1.9
- Documentation only: snapshot handling, the datastore naming rule and the storage rescan are
  described as coming from a review of internal processes. No code changes.

## 0.1.8
- **GFS2 only, everywhere.** Before, three places could reach past GFS2:
  - Volumes were matched to Morpheus datastores of every type (NFS, directory, ...). Now only
    HPE Clustered Datastores (`libvirt-dir-gfs2`) are matched.
  - Attach copied its `blockDevice` value format from any datastore in the cluster. Now only from
    other GFS2 datastores. (Refusing a device another datastore already uses still checks all types.)
  - The host script trusted udev's cached filesystem type. Now every device is confirmed GFS2 by
    probing its superblock (`blkid -p`) when listing volumes and before every step; a stale udev
    entry for a reformatted LUN is skipped. The demo tool does the same.
  - The server now also drops anything the script does not report as probed GFS2 with a GFS2 lock
    protocol, and checks the selected volume again before starting a step.
- The Adopt name check (refuse an existing datastore name) is now a separate lookup across all
  datastore types, used only for that check.
- Full documentation in `docs/`; README shortened to an overview with links.
- Wording of comments and changelog entries reviewed against internal processes.
- Script v0.5.

## 0.1.7
- **Duplicate filesystem UUIDs** (an array snapshot exported to the same hosts as its original): volumes are now keyed by WWID, so the two LUNs are two rows instead of
  being merged into one. Both are badged **Duplicate UUID**, a warning names the pair, and every step
  is refused on them except the new **Re-UUID**.
- **Re-UUID** (`gfs2-rescue.sh reuuid`): backs up the superblock region, then `tunegfs2 -U <new>`.
  Data and lock table are unchanged. Refused on the volume in use or on a Morpheus datastore; needs
  the "this LUN is the copy" box and the WWID typed. A Collect right after it reuses the same run.
- **Lock-table clash**: a copy keeps the original's lock table after Re-UUID. Attach is refused
  until it is adopted under its own datastore name (Adopt suggests `<name>-copy`); Adopt refuses a
  lock table another LUN uses or a datastore name that already exists.
- Mount detection now uses the device number instead of the UUID (a UUID match reported an
  unmounted copy as mounted), and the UUID is read from the superblock (`blkid -p`), not udev's cache.
  A live DLM lockspace is credited to the mounted LUN, not the unmounted copy sharing its name.
- **Rescan storage** button: SCSI/iSCSI rescan on every host (`echo "- - -"` per SCSI host,
  `iscsiadm -m session --rescan`, `udevadm settle`), then a normal scan. For a LUN just exported.
  Multipath maps are not reloaded.
- **Attach is recorded** in the run's log and `state.json`, so "Last step" shows
  "Attach -> requested", then "Attach -> ok, datastore X mounted on N of M hosts" once Morpheus has
  mounted it. Before, "Last step" stayed on Adopt.
- Clearer reasons on greyed-out steps: "already attached as Morpheus datastore 'X'", "in use as
  Morpheus datastore 'X' (mounted on ...)", and Verify now says to Attach first.
- Adopt's log no longer tells you to add the datastore by hand in Morpheus; it points to Attach.
- Setting **API token credential** takes a name or a numeric ID, and the help text no longer says it
  must be a Username and Password credential (an API Key credential worked). The tab header shows
  which credential it found, with its ID and type.
- Script v0.4: `reuuid`, `rescan`, `record` commands.

## 0.1.6
- **Datastore name** is chosen at Adopt, and the lock table is written from it:
  `<this cluster>:<name with - as _>` (Morpheus's naming rule; vm-store ->
  vm_store). A live preview shows the exact lock table while typing. The free-text lock table field
  is gone; the server derives the lock table itself.
- Attach shows the name fixed by the lock table and the server refuses any other name, so Morpheus
  never sees a mismatch.
- Names are limited to 1-30 letters, digits, - and _ (exact mapping, fits GFS2's fsname limit).

## 0.1.5
- Fix: the WWID confirm box showed the WWID as grey placeholder text, which looked typed in the
  dark theme, so Repair/Adopt kept failing the confirmation. The box now starts visibly empty, the
  WWID to type is shown in the label, and a live "WWID matches" indicator updates as you type.
- Fix: the snapshot checkbox is forced to a real, clickable checkbox (Morpheus's own styling could
  hide or block it), inside a bordered confirmation area.
- The alert now names exactly what is missing (snapshot box, WWID not typed, WWID mismatch).
- Typed values (lock table, datastore name, confirmations) survive refreshes and polling; the
  confirmation is cleared after Repair or Adopt starts and when another volume is selected.

## 0.1.4
- New **Attach** step: adds the adopted volume as an HPE Clustered Datastore through the Morpheus
  API (`POST /api/clusters/{id}/data-stores`, type `libvirt-dir-gfs2`, `config.allowReformat: false`,
  `defaultStore: false`), then waits until Morpheus has created and mounted it. Only offered when the
  lock table belongs to this cluster, no datastore uses the device and nothing has it mounted.
  Refuses duplicates by device and by name; copies the `blockDevice` value format of existing stores.
- Requests carrying any reformat parameter are refused. The tab no longer sends anyone to Morpheus's
  Add Data Store dialog.
- New settings: **API token credential ID** (Trust credential, read like Argus; token never logged)
  and **Appliance API URL** (default `https://127.0.0.1`).
- `tools/gfs2-demo-orphan.sh`: `--format` removed. It rewrites the lock table of a GFS2 volume, or
  creates GFS2 only on a completely blank LUN; anything else is refused.

## 0.1.3
- Tab renamed **GFS2 Storage** (was Shared Storage).
- Cluster confirmation box at the top: Morpheus cluster name, the hosts' DLM cluster name and the
  host count; the work panel also names the cluster.
- Only this cluster is shown: hosts come from the Morpheus cluster record, and a host whose DLM
  cluster name differs from the others is listed as left out and contributes no volumes.
- Volumes are a collapsible tree (Hosts and GFS2 volumes nodes, one expandable node per volume with
  its details and a "Work on this volume" button); open/closed state survives rescans.
- Theme: explicit high-contrast colours for every element in light and dark, a darker dark theme,
  and readable log text.

## 0.1.2
- New plugin setting **Enable GFS2 Rescue** (checkbox, off by default). While off, the Shared Storage
  tab is hidden, the script loader is not injected, and every route answers 403. Scripts and run
  folders already on hosts are left in place.
- Lock tables and paths in the tab no longer pick up the dark theme's red `code` colour.
- `tools/gfs2-demo-orphan.sh` (demo LUN preparation) now ships in the repo; when it formats, it
  creates 32 journals like Morpheus does. An existing GFS2 volume always keeps its own journals.

## 0.1.1
- Load `gfs2-rescue.js` on every page through a GlobalUIComponentProvider (`Gfs2RescueLoaderProvider`).
  Tab HTML is inserted as trusted HTML, which strips `<script>` tags (seen in the VME migration plugin,
  May 2026); the script now finds and binds the Shared Storage tab itself with a MutationObserver.
- `getRoutes()` is `@CompileStatic` with explicit `Route.build` calls (dynamic `Permission.build`
  resolution threw MissingPropertyException in the VME migration plugin).
- `build.gradle`: capability resolution picks Groovy 4 over plugin-api 1.5.0's Groovy 3 dependencies.
- Windows builds: `.gitattributes` keeps scripts LF; the bundled script is CR-stripped at load.

## 0.1.0
- First version: Shared Storage cluster tab with Collect, Check, Repair, Adopt and Verify,
  bundled gfs2-rescue.sh v0.3 deployed to hosts through the Morpheus agent.

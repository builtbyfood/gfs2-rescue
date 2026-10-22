# Screenshots to capture

Every `Screenshot (…)` placeholder in the docs, in the order a demo run produces them. Capture them
from one rehearsal on a scratch LUN ([Demo LUN](../10-demo-lun.md)), save them here under these
names. All are embedded in the docs: 14 for the walkthrough, plus 8 for taking over a snapshot copy.

The published screenshots are redacted: cluster and DLM names, host names, LUN WWIDs, datastore
names other than the demo ones, the appliance address and unrelated credentials are covered with
solid boxes (not blur). Do the same for any new screenshot.

Before capturing: dark or light theme consistently, browser zoom 100%, and nothing on screen that
identifies your environment (appliance address, host names you don't want public, tokens).

| # | File | Used in | What it shows |
| --- | --- | --- | --- |
| 1 | `02-plugin-settings.png` | [02-install-and-settings.md](../02-install-and-settings.md) | the plugin's Edit dialog with Enable GFS2 Rescue ticked, the API token credential and the Appliance API URL. |
| 2 | `02-trust-credential.png` | [02-install-and-settings.md](../02-install-and-settings.md) | Infrastructure → Trust → Credentials with the API Key credential used by Attach. |
| 3 | `00-tab-overview.png` | [01-overview.md](../01-overview.md) | the GFS2 Storage tab on a cluster, with the cluster box, the Hosts list and the GFS2 volumes tree. |
| 4 | `03-cluster-box.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | the top of the tab: Morpheus cluster, DLM cluster name, host count and API credential. |
| 5 | `03-volume-foreign.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | the GFS2 volumes tree with the orphaned volume expanded, badged From another cluster. |
| 6 | `03-work-panel.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | the work panel: Run on host, current lock table, the step buttons with their reasons, and the empty log. |
| 7 | `03-collect.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | Collect running, with the spinner and the log refreshing. |
| 8 | `03-check-clean.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | Last step: Check → clean, with Adopt now offered. |
| 9 | `03-adopt-name.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | the Datastore name field with the live lock table preview, the snapshot box ticked and "WWID matches". |
| 10 | `03-adopt-ok.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | Last step: Adopt → ok, the badge This cluster, and the superblock after in the log. |
| 11 | `03-attach-progress.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | Morpheus's progress bar for the new datastore and the tab's "waiting for Morpheus" line. |
| 12 | `03-verify-ok.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | Last step: Verify → ok, with zero missing, unreadable and hash failures in the log. |
| 13 | `03-datastore-in-morpheus.png` | [03-takeover-walkthrough.md](../03-takeover-walkthrough.md) | the cluster's Storage → Data Stores list with the new HPE Clustered Datastore online. |
| 14 | `06-duplicate-uuid.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | two volumes badged Duplicate UUID, the warning naming the pair, and Re-UUID the only step offered on the copy. |
| 15 | `06-duplicate-re-uuid.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Last step Re-UUID → ok with the old and new UUID; the copy now badged This cluster, still sharing the lock table |
| 16 | `06-duplicate-re-uuid-collect.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Collect → ok on the copy, in the same run folder as the Re-UUID |
| 17 | `06-duplicate-re-uuid-check.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Check → clean on the copy, with Adopt offered |
| 18 | `06-duplicate-re-uuid-adopt-name.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | The datastore name prefilled as <name>-copy, the lock table preview and WWID matches |
| 19 | `06-duplicate-re-uuid-adopt-ok.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Adopt → ok with the new lock table; Attach offered |
| 20 | `06-duplicate-re-uuid-attach-progress.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | The tab waiting for Morpheus to create and mount the copy |
| 21 | `06-duplicate-re-uuid-attach-progress2.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Morpheus's progress bar while the copy mounts |
| 22 | `06-duplicate-re-uuid-attach-verify.png` | [06-snapshots-and-duplicates.md](../06-snapshots-and-duplicates.md) | Verify → ok on the copy |

For the snapshot shots (`06-…`), clone the demo LUN on the array after it is attached, present the
clone to the same hosts, click Rescan storage, then take the copy over as in the snapshots page.

package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.MorpheusContext
import com.morpheusdata.core.Plugin
import com.morpheusdata.core.data.DataQuery
import com.morpheusdata.model.Permission
import com.morpheusdata.views.JsonResponse
import com.morpheusdata.views.ViewModel
import com.morpheusdata.web.PluginController
import com.morpheusdata.web.Route
import groovy.util.logging.Slf4j

/**
 * Routes (all POST, admin-cm full, core CSRF token + X-GR-Request header, same guard as vm-folders):
 *   /gfs2Rescue/scan    clusterId                       -> hosts + merged GFS2 volumes
 *   /gfs2Rescue/status  clusterId, hostId, wwid[, full] -> current run, state.json, log tail, allowed steps
 *   /gfs2Rescue/start   clusterId, hostId, wwid, step[, datastoreName, confirm, snapshot, allowUnreadable]
 *   /gfs2Rescue/rescan  clusterId                       -> SCSI/iSCSI rescan on every host, then scan
 *
 * Every step re-checks the whole cluster (inspect on every host) before it starts, so a volume
 * mounted or locked anywhere in the cluster is refused server-side, whatever the page showed.
 */
@Slf4j
class Gfs2RescueController implements PluginController {

    MorpheusContext morpheusContext
    Plugin plugin
    HostRunner runner
    Settings settings
    MorpheusApi api

    static final String REQ_HEADER = 'X-GR-Request'

    Gfs2RescueController(Plugin plugin, MorpheusContext morpheusContext, HostRunner runner, Settings settings) {
        this.plugin = plugin
        this.morpheusContext = morpheusContext
        this.runner = runner
        this.settings = settings
        this.api = new MorpheusApi(morpheusContext, settings)
    }

    @Override String getCode() { 'gfs2-rescue-controller' }
    @Override String getName() { 'GFS2 Rescue Controller' }
    @Override Plugin getPlugin() { plugin }
    @Override MorpheusContext getMorpheus() { morpheusContext }

    // @CompileStatic: Permission/Route resolved at compile time (dynamic resolution threw
    // MissingPropertyException in the VME migration plugin, May 2026)
    @groovy.transform.CompileStatic
    @Override
    List<Route> getRoutes() {
        Permission perm = Permission.build('admin-cm', 'full')
        return [
            Route.build('/gfs2Rescue/scan',   'scan',   perm),
            Route.build('/gfs2Rescue/status', 'status', perm),
            Route.build('/gfs2Rescue/start',  'start',  perm),
            Route.build('/gfs2Rescue/rescan', 'rescan', perm)
        ]
    }

    // ---------------------------------------------------------------- guards

    private JsonResponse guard(ViewModel<Map> model) {
        if (!settings.enabled()) return reject(403, 'GFS2 Rescue is turned off in its plugin settings')
        def req = model?.request
        if (req == null) return reject(400, 'invalid request')
        String verb = ''
        try { verb = (req.respondsTo('getMethod') ? req.getMethod() : req.method)?.toString()?.toUpperCase() ?: '' }
        catch (ex) { return reject(400, 'invalid request') }
        if (verb != 'POST') return reject(405, 'POST required')
        if (!header(req, REQ_HEADER)) return reject(403, 'missing request header')
        def origin = header(req, 'Origin') ?: header(req, 'Referer')
        if (origin) {
            String oh = ''
            try { oh = new URI(origin).host ?: '' } catch (ex) {}
            String sn = ''
            try { sn = req.respondsTo('getServerName') ? (req.getServerName() ?: '') : '' } catch (ex) {}
            String rh = (header(req, 'X-Forwarded-Host') ?: header(req, 'Host') ?: sn ?: '').split(',')[0].trim().split(':')[0]
            if (!oh || !oh.equalsIgnoreCase(rh)) return reject(403, 'cross-origin request rejected')
        }
        if (!model?.user?.account) return reject(401, 'no authenticated user')
        return null
    }

    private static String header(def req, String name) {
        try { return req.respondsTo('getHeader') ? req.getHeader(name)?.toString() : null } catch (ex) { return null }
    }

    private static String param(ViewModel<Map> model, String name) {
        try { return model?.request?.getParameter(name)?.toString()?.trim() } catch (ex) { return null }
    }

    private static JsonResponse reject(int status, String msg) {
        def r = JsonResponse.of([success: false, error: msg])
        r.status = status
        return r
    }

    private static boolean canAccess(ViewModel<Map> model, def owner) {
        def acct = model?.user?.account
        if (!acct) return false
        if (acct.masterAccount) return true
        return owner?.id == acct.id
    }

    /** The cluster and its hypervisor hosts, tenant-checked. */
    private Map loadCluster(ViewModel<Map> model, String clusterIdStr) {
        if (!clusterIdStr?.isLong()) return [error: reject(400, 'clusterId required')]
        def cluster = morpheusContext.services.cluster.get(clusterIdStr as Long)
        if (!cluster || !canAccess(model, cluster.owner)) return [error: reject(404, 'cluster not found')]
        List hosts = []
        try {
            hosts = morpheusContext.services.computeServer.list(new DataQuery(model.user).withFilter('serverGroup.id', cluster.id)).toList()
        } catch (ex) {
            log.debug("GFS2 Rescue: serverGroup filter failed (${ex.message}); filtering in memory")
            hosts = morpheusContext.services.computeServer.list(new DataQuery(model.user)).toList().findAll { it.serverGroup?.id == cluster.id }
        }
        hosts = hosts.findAll { h ->
            try { h.serverGroup?.id == cluster.id && h.computeServerType?.vmHypervisor == true && canAccess(model, h.account) } catch (ex) { false }
        }.sort { it.name }
        return [cluster: cluster, hosts: hosts]
    }

    /** inspect on every host; returns [hostRows, merged]. */
    private Map scanHosts(List hosts) {
        List<Map> rows = [], results = []
        hosts.each { h ->
            Map row = [id: h.id, name: h.name?.toString(), mode: null, script: null, error: null, hostCluster: null]
            try {
                row.mode = runner.mode(h)
                if (row.mode == 'none') row.error = 'agent is not root and cannot sudo without a password'
                else {
                    Map dep = runner.ensureScript(h)
                    row.script = dep.ok ? (dep.uploaded ? 'installed' : 'current') : 'failed'
                    if (!dep.ok) row.error = dep.error
                    else {
                        Map ins = runner.inspect(h)
                        if (ins.ok) {
                            row.hostCluster = ins.data?.hostCluster
                            results << [host: [id: h.id, name: h.name?.toString()], data: ins.data, units: ins.units]
                        } else row.error = ins.error
                    }
                }
            } catch (ex) {
                row.error = ex.message
            }
            rows << row
        }
        return [hosts: rows, merged: Rules.merge(results)]
    }

    /**
     * HPE Clustered Datastores (type libvirt-dir-gfs2) keyed by their on-host path (/mnt/<uuid>).
     * Every other datastore type (NFS, directory, ...) is ignored, so a GFS2 volume can only ever
     * be matched to a GFS2 datastore.
     */
    private Map datastoresByPath(ViewModel<Map> model) {
        Map out = [:]
        try {
            morpheusContext.services.cloud.datastore.list(new DataQuery(model.user)).each { d ->
                try {
                    if (d.externalPath && d.datastoreType?.code?.toString() == MorpheusApi.GFS2_TYPE && canAccess(model, d.owner))
                        out[d.externalPath.toString()] = [id: d.id, name: d.name?.toString(), type: MorpheusApi.GFS2_TYPE]
                } catch (ignored) {}
            }
        } catch (ex) { log.debug("GFS2 Rescue: datastore list failed: ${ex.message}") }
        return out
    }

    /**
     * Names of all datastores the user can see, any type. Only used to refuse an Adopt name that is
     * already taken; nothing here is shown or acted on.
     */
    private Set<String> datastoreNames(ViewModel<Map> model) {
        Set<String> out = [] as Set
        try {
            morpheusContext.services.cloud.datastore.list(new DataQuery(model.user)).each { d ->
                try { if (d.name && canAccess(model, d.owner)) out << d.name.toString().toLowerCase() } catch (ignored) {}
            }
        } catch (ex) { log.debug("GFS2 Rescue: datastore list failed: ${ex.message}") }
        return out
    }

    /** inspect on every host + Morpheus datastores matched by mount path. */
    private Map freshView(ViewModel<Map> model, List hosts) {
        Map s = scanHosts(hosts)
        Map ds = datastoresByPath(model)
        // Morpheus checks the device on EVERY host when it creates a datastore, so Attach needs every
        // host of the cluster (not left out for another DLM name) to see it, and to have been checked.
        List<Long> excluded = (s.merged.excludedHosts as List).collect { it.id as Long }
        List<Map> clusterHosts = (s.hosts as List).findAll { !((it.id as Long) in excluded) }
        (s.merged.volumes as List).each { Map v ->
            def mp = (v.mountedOn as List).find()?.mountpoint
            v.datastore = mp ? ds[mp] : null
            List<Long> seen = (v.seenOn as List).collect { it.id as Long }
            v.notSeenOn = clusterHosts.findAll { !it.error && !((it.id as Long) in seen) }.collect { it.name }
            v.uncheckedOn = clusterHosts.findAll { it.error }.collect { it.name }
        }
        return s
    }

    // ---------------------------------------------------------------- routes

    def scan(ViewModel<Map> model) {
        try {
            def denied = guard(model); if (denied) return denied
            Map c = loadCluster(model, param(model, 'clusterId')); if (c.error) return c.error
            return JsonResponse.of(scanResult(model, c, []))
        } catch (ex) {
            log.error("GFS2 Rescue scan failed: ${ex.message}", ex)
            return JsonResponse.of([success: false, error: ex.message])
        }
    }

    /** Asks every host's SCSI/iSCSI layer for new LUNs, then scans. For a LUN just exported. */
    def rescan(ViewModel<Map> model) {
        try {
            def denied = guard(model); if (denied) return denied
            Map c = loadCluster(model, param(model, 'clusterId')); if (c.error) return c.error
            List<String> notes = []
            (c.hosts as List).each { h ->
                try {
                    if (runner.mode(h) == 'none') return
                    if (!runner.ensureScript(h).ok) return
                    Map r = runner.rescan(h)
                    if (!r.ok) notes << "Storage rescan on ${h.name} failed: ${r.error}".toString()
                } catch (ex) { notes << "Storage rescan on ${h.name} failed: ${ex.message}".toString() }
            }
            log.info("GFS2 Rescue: user=${model.user?.username} storage rescan on cluster ${c.cluster.name} (${(c.hosts as List).size()} hosts)")
            return JsonResponse.of(scanResult(model, c, notes))
        } catch (ex) {
            log.error("GFS2 Rescue rescan failed: ${ex.message}", ex)
            return JsonResponse.of([success: false, error: ex.message])
        }
    }

    private Map scanResult(ViewModel<Map> model, Map c, List<String> warnings) {
        Map s = freshView(model, c.hosts as List)
        String dlm = s.merged.clusterName as String
        (s.merged.excludedHosts as List).each { Map x ->
            Map row = (s.hosts as List).find { it.id == x.id } as Map
            if (row) { row.excluded = true; row.error = "reports DLM cluster ${x.hostCluster}, not ${dlm}: left out".toString() }
            warnings << "${x.name} reports DLM cluster ${x.hostCluster}, not ${dlm}; it is left out of this tab.".toString()
        }
        if (!dlm && (s.merged.clusterNames as List)) warnings << "The hosts do not agree on a DLM cluster name (${s.merged.clusterNames.join(', ')}); Adopt is disabled.".toString()
        if (!(c.hosts as List)) warnings << 'No hypervisor hosts found in this cluster.'
        Set<String> seen = [] as Set
        (s.merged.volumes as List).each { Map v ->
            if (v.dupUuid) {
                List<String> grp = ([v.device] + (v.dupUuidWith as List)).collect { it.toString() }.sort()
                if (seen.add('u:' + grp.join(',')))
                    warnings << ("${grp.join(' and ')} carry the same filesystem UUID ${v.uuid} (an array snapshot exported to the same hosts?). " +
                                 'Every step is blocked on them until the copy gets a new UUID with Re-UUID. Pick the copy, never the volume in use.').toString()
            } else if (v.lockTableClash) {
                List<String> grp = ([v.device] + (v.lockTableClashWith as List)).collect { it.toString() }.sort()
                if (seen.add('l:' + grp.join(',')))
                    warnings << "${grp.join(' and ')} have the same lock table ${v.lockTable}. Adopt the copy under a new datastore name before attaching it.".toString()
            }
        }
        Map cred = settings.apiCredentialId() ? api.credential() : [ok: false, error: 'not set']
        return [success: true, version: Gfs2RescuePlugin.VERSION, scriptSha: runner.scriptSha,
                cluster: [id: c.cluster.id, name: c.cluster.name?.toString(), dlmName: s.merged.clusterName,
                          hostCount: (c.hosts as List).size()],
                hosts: s.hosts, volumes: s.merged.volumes, warnings: warnings,
                apiConfigured: settings.apiCredentialId() != null,
                apiCredential: cred.ok ? [id: cred.id, name: cred.name, type: cred.type] : [error: cred.error]]
    }

    def status(ViewModel<Map> model) {
        try {
            def denied = guard(model); if (denied) return denied
            Map c = loadCluster(model, param(model, 'clusterId')); if (c.error) return c.error
            String wwid = param(model, 'wwid'); String hostId = param(model, 'hostId')
            if (!wwid || !Rules.WWID.matcher(wwid).matches()) return reject(400, 'wwid invalid')
            def host = (c.hosts as List).find { it.id?.toString() == hostId }
            if (!host) return reject(404, 'host not in this cluster')
            Map s = freshView(model, c.hosts as List)
            Map vol = (s.merged.volumes as List).find { it.wwid == wwid }
            if (!vol) return reject(404, 'volume not seen by this cluster')
            int lines = param(model, 'full') == '1' ? 5000 : 40
            Map st = runner.status(host, wwid, lines, followUuid(vol))
            Map stState = (st.state instanceof Map) ? new LinkedHashMap(st.state as Map) : null
            if (stState?.step == 'attach' && stState.result == 'requested' && vol.datastore && (vol.mountedOn as List)) {
                stState.result = 'ok'
                stState.detail = "datastore ${(vol.datastore as Map).name} mounted on ${(vol.mountedOn as List).size()} of ${(c.hosts as List).size()} hosts".toString()
            }
            st.state = stState
            Map allow = Rules.allowed(vol, st, host.id as Long, s.merged.clusterName as String, settings.apiCredentialId() != null)
            return JsonResponse.of([success: true, volume: vol, host: [id: host.id, name: host.name?.toString()],
                                    run: st.run, unit: st.unit, active: st.active, manifest: st.manifest,
                                    state: st.state, log: st.log, allowed: allow.allowed, reasons: allow.reasons,
                                    needsAllowUnreadable: allow.needsAllowUnreadable, clusterDlmName: s.merged.clusterName,
                                    adoptedFrom: st.adoptedFrom])
        } catch (ex) {
            log.error("GFS2 Rescue status failed: ${ex.message}", ex)
            return JsonResponse.of([success: false, error: ex.message])
        }
    }

    def start(ViewModel<Map> model) {
        try {
            def denied = guard(model); if (denied) return denied
            Map c = loadCluster(model, param(model, 'clusterId')); if (c.error) return c.error
            String wwid = param(model, 'wwid'), hostId = param(model, 'hostId'), step = param(model, 'step')
            if (!wwid || !Rules.WWID.matcher(wwid).matches()) return reject(400, 'wwid invalid')
            if (!(step in Rules.STEPS)) return reject(400, 'unknown step')
            def host = (c.hosts as List).find { it.id?.toString() == hostId }
            if (!host) return reject(404, 'host not in this cluster')

            // fresh view of the whole cluster, then the same rules the page used
            // a reformat flag is never accepted from the browser, whatever its value
            def req = model?.request
            boolean reformatParam = false
            try { reformatParam = ['allowReformat', 'reformat', 'format'].any { req.getParameter(it) != null } } catch (ignored) {}
            if (reformatParam) return reject(400, 'reformatting is not something this tool does')

            Map s = freshView(model, c.hosts as List)
            Map vol = (s.merged.volumes as List).find { it.wwid == wwid }
            if (!vol) return reject(404, 'volume not seen by this cluster')
            if (!(vol.seenOn as List).any { it.id?.toString() == hostId }) return reject(409, 'that host cannot see this volume')
            if (!Rules.isGfs2(vol)) return reject(409, 'not a GFS2 filesystem: this tool only works on GFS2')
            Map st = runner.status(host, wwid, 1, followUuid(vol))
            Map allow = Rules.allowed(vol, st, host.id as Long, s.merged.clusterName as String, settings.apiCredentialId() != null)
            if (!(step in allow.allowed)) return reject(409, "${step} not allowed: ${allow.reasons[step] ?: 'conditions not met'}".toString())

            String dev = vol.device.toString()
            if (dev != "/dev/mapper/${wwid}".toString()) return reject(409, 'device path does not match the wwid')

            if (step == 'attach') {
                String name = param(model, 'datastoreName') ?: Rules.suggestedName(vol.fsName?.toString())
                if (!name || !Rules.DSNAME.matcher(name).matches()) return reject(400, 'datastore name: 1-30 letters, digits, - or _')
                if (Rules.fsNameFor(name) != vol.fsName?.toString())
                    return reject(400, "the datastore name must match the lock table: '${name}' would need ${s.merged.clusterName}:${Rules.fsNameFor(name)}, the volume has ${vol.lockTable}. Use '${Rules.suggestedName(vol.fsName?.toString())}' or Adopt again with the new name.".toString())
                Map a = api.attach(c.cluster.id as Long, name, dev, wwid)
                log.info("GFS2 Rescue: user=${model.user?.username} step=attach device=${dev} name=${name} result=${a.ok ? 'requested' : a.error}")
                runner.record(host, wwid, 'attach', a.ok ? 'requested' : 'error',
                              a.ok ? "datastore ${name} requested through the API (id ${a.datastoreId ?: '?'}), reformatting off".toString()
                                   : "datastore ${name}: ${a.error}".toString())
                if (!a.ok) return reject(409, a.error as String)
                return JsonResponse.of([success: true, step: 'attach', datastoreId: a.datastoreId, executionId: a.executionId])
            }
            List<String> args
            switch (step) {
                case 'reuuid':
                    if (!confirmed(model, wwid)) return reject(400, 'confirm the array snapshot and type the WWID')
                    args = [dev, '--yes']; break
                case 'collect': args = [dev, '--hash-under-mb', '64']; break
                case 'check':   args = [dev]; break
                case 'repair':
                    if (!confirmed(model, wwid)) return reject(400, 'confirm the array snapshot and type the WWID')
                    args = [dev, '--yes']; break
                case 'adopt':
                    if (!confirmed(model, wwid)) return reject(400, 'confirm the array snapshot and type the WWID')
                    // The datastore name decides the lock table: <this cluster>:<name with - as _>
                    String dsName = param(model, 'datastoreName') ?: Rules.suggestedName(vol.fsName?.toString())
                    if (!dsName || !Rules.DSNAME.matcher(dsName).matches())
                        return reject(400, 'datastore name: 1-30 letters, digits, - or _, starting with a letter or digit')
                    String lt = "${s.merged.clusterName}:${Rules.fsNameFor(dsName)}".toString()
                    if (!Rules.LOCKTABLE.matcher(lt).matches()) return reject(400, "lock table ${lt} is not valid".toString())
                    // two LUNs must never share a lock table (and so a DLM lockspace) in one cluster
                    Map clash = (s.merged.volumes as List).find { it.wwid != wwid && it.lockTable == lt } as Map
                    if (clash) return reject(409, "${clash.device} already uses lock table ${lt}: choose another datastore name".toString())
                    if (datastoreNames(model).contains(dsName.toLowerCase()))
                        return reject(409, "a Morpheus datastore named '${dsName}' already exists: choose another name".toString())
                    args = [dev, '--locktable', lt, '--yes']
                    if (allow.needsAllowUnreadable) {
                        if (param(model, 'allowUnreadable') != 'on') return reject(400, 'the repair left unreadable entries: tick "accept unreadable entries" to continue')
                        args << '--allow-unreadable'
                    }
                    break
                case 'verify':
                    String mp = (vol.mountedOn as List).find { it.id?.toString() == hostId }?.mountpoint
                    if (!mp || !Rules.MOUNT.matcher(mp).matches()) return reject(409, 'not mounted on this host')
                    args = [mp]; break
                default: return reject(400, 'unknown step')
            }

            Map r = runner.start(host, wwid, step, args)
            log.info("GFS2 Rescue: user=${model.user?.username} step=${step} device=${dev} host=${host.name} result=${r.ok ? 'started ' + r.run : r.error}")
            if (!r.ok) return reject(409, r.error as String)
            return JsonResponse.of([success: true, step: step, run: r.run])
        } catch (ex) {
            log.error("GFS2 Rescue start failed: ${ex.message}", ex)
            return JsonResponse.of([success: false, error: ex.message])
        }
    }

    /** Filesystem UUID a run may be followed by; never for duplicates (two LUNs, one UUID). */
    private static String followUuid(Map vol) {
        String u = vol?.uuid?.toString()?.toLowerCase()
        return (!vol?.dupUuid && u ==~ /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ? u : null
    }

    private static boolean confirmed(ViewModel<Map> model, String wwid) {
        return param(model, 'snapshot') == 'on' && param(model, 'confirm') == wwid
    }
}

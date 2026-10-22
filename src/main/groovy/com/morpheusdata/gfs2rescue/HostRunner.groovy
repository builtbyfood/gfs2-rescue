package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.MorpheusContext
import com.morpheusdata.core.Plugin
import groovy.json.JsonSlurper
import groovy.util.logging.Slf4j

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Everything that touches a hypervisor host goes through here.
 *
 * Transport (same as vm-folders / hvm-updater / Migration Assist):
 *  - executeCommandOnServer(server, cmd), 2-arg form = Morpheus agent, no SSH keys.
 *  - stdout is in TaskResult.data; TaskResult.output may be null on the agent path.
 *  - success is judged by marker strings and exit codes, never by stdout alone.
 *
 * Privilege: the first call per host runs `id -u`. uid 0 runs commands directly; otherwise
 * `sudo -n` is tried; if that is refused the host is reported as not usable.
 *
 * The script ships inside the plugin jar. Before use its SHA-256 on the host is compared with
 * the bundled copy; a missing or different copy is uploaded as base64 chunks, decoded on the
 * host and only installed when the hash matches.
 *
 * Every value placed in a command is validated by the caller (regex) AND single-quoted here.
 */
@Slf4j
class HostRunner {

    static final String DIR    = '/opt/gfs2-rescue'
    static final String SCRIPT = DIR + '/gfs2-rescue.sh'
    static final String RUNS   = '/var/lib/gfs2-rescue'
    static final int    CHUNK  = 3000

    final MorpheusContext morpheus
    final byte[] script
    final String scriptSha
    private final Map<Long, String> modeCache = new ConcurrentHashMap<>()
    private final Map<Long, String> deployedSha = new ConcurrentHashMap<>()

    HostRunner(Plugin plugin, MorpheusContext morpheus) {
        this.morpheus = morpheus
        InputStream is = plugin.classLoader.getResourceAsStream('scripts/gfs2-rescue.sh')
        if (is == null) throw new IllegalStateException('bundled scripts/gfs2-rescue.sh not found in the plugin jar')
        // A Windows checkout can turn the script's LF into CRLF, which breaks bash on the host.
        // Normalise here so the hash and the uploaded copy are always the LF version.
        this.script = new String(is.withCloseable { it.bytes }, 'UTF-8').replace('\r\n', '\n').getBytes('UTF-8')
        this.scriptSha = sha256(script)
    }

    // ---------------------------------------------------------------- basics

    static String q(String s) { "'" + (s ?: '').replace("'", "'\"'\"'") + "'" }

    static String sha256(byte[] b) {
        MessageDigest.getInstance('SHA-256').digest(b).collect { String.format('%02x', it) }.join()
    }

    /** One agent command. Never throws; returns [ok, out, exit, error]. */
    Map exec(def server, String cmd, int timeoutSec = 60) {
        try {
            def r = morpheus.executeCommandOnServer(server, cmd)
                        .timeout(timeoutSec, TimeUnit.SECONDS)
                        .blockingGet()
            String out = (r?.data != null ? r.data : (r?.output ?: '')).toString()
            return [ok: r?.success == true, out: out, exit: r?.exitCode?.toString(), error: (r?.error ?: r?.msg)?.toString()]
        } catch (java.util.concurrent.TimeoutException te) {
            return [ok: false, out: '', exit: null, error: "timed out after ${timeoutSec}s".toString()]
        } catch (Throwable t) {
            // RxJava wraps the timeout; unwrap for a clear message
            def cause = t.cause instanceof java.util.concurrent.TimeoutException ? "timed out after ${timeoutSec}s" : t.message
            log.warn("GFS2 Rescue: command failed on ${server?.name}: ${t.class.simpleName}: ${cause}")
            return [ok: false, out: '', exit: null, error: cause?.toString()]
        }
    }

    /** 'root', 'sudo' or 'none' (cached per host). */
    String mode(def server) {
        Long id = server.id as Long
        String m = modeCache.get(id)
        if (m) return m
        Map r = exec(server, 'id -u', 20)
        String uid = r.out?.trim()
        if (uid == '0') m = 'root'
        else {
            Map s = exec(server, 'sudo -n true 2>/dev/null && echo GR-SUDO-OK', 20)
            m = s.out?.contains('GR-SUDO-OK') ? 'sudo' : 'none'
        }
        log.info("GFS2 Rescue: agent on ${server?.name} runs as uid ${uid ?: '?'} -> mode ${m}")
        modeCache.put(id, m)
        return m
    }

    /** Wrap a shell command so it runs as root. */
    String root(def server, String cmd) {
        switch (mode(server)) {
            case 'root': return cmd
            case 'sudo': return 'sudo -n bash -c ' + q(cmd)
            default: throw new IllegalStateException("the Morpheus agent on ${server?.name} is not root and cannot sudo without a password")
        }
    }

    // ---------------------------------------------------------------- script deploy

    /** Makes sure the host has exactly the bundled script. Returns [ok, uploaded, error]. */
    Map ensureScript(def server) {
        Long id = server.id as Long
        if (deployedSha.get(id) == scriptSha) return [ok: true, uploaded: false]
        Map cur = exec(server, root(server, "sha256sum ${SCRIPT} 2>/dev/null | cut -d' ' -f1"), 30)
        if (cur.out?.trim() == scriptSha) { deployedSha.put(id, scriptSha); return [ok: true, uploaded: false] }

        String b64 = script.encodeBase64().toString()
        Map prep = exec(server, root(server, "mkdir -p ${DIR} && chmod 0750 ${DIR} && : > ${DIR}/.upload.b64 && echo GR-OK"), 30)
        if (!prep.out?.contains('GR-OK')) return [ok: false, error: "cannot prepare ${DIR}: ${prep.error ?: prep.out}".toString()]
        for (int i = 0; i < b64.length(); i += CHUNK) {
            String part = b64.substring(i, Math.min(b64.length(), i + CHUNK))   // base64 alphabet only: safe in quotes
            Map c = exec(server, root(server, "printf '%s' '${part}' >> ${DIR}/.upload.b64 && echo GR-OK"), 30)
            if (!c.out?.contains('GR-OK')) return [ok: false, error: "upload chunk ${(i / CHUNK) as int} failed: ${c.error ?: c.out}".toString()]
        }
        Map fin = exec(server, root(server,
            "base64 -d ${DIR}/.upload.b64 > ${DIR}/.upload.sh && " +
            "[ \"\$(sha256sum ${DIR}/.upload.sh | cut -d' ' -f1)\" = '${scriptSha}' ] && " +
            "install -m 0750 ${DIR}/.upload.sh ${SCRIPT} && rm -f ${DIR}/.upload.b64 ${DIR}/.upload.sh && echo GR-HASH-OK " +
            "|| { rm -f ${DIR}/.upload.sh; echo GR-HASH-BAD; exit 3; }"), 30)
        if (!fin.out?.contains('GR-HASH-OK')) return [ok: false, error: "script did not verify on the host (SHA-256): ${fin.out?.trim() ?: fin.error}".toString()]
        deployedSha.put(id, scriptSha)
        log.info("GFS2 Rescue: installed gfs2-rescue.sh on ${server?.name} (${script.length} bytes, sha256 ${scriptSha})")
        return [ok: true, uploaded: true]
    }

    // ---------------------------------------------------------------- inspect / status / start

    /** inspect --json plus the gfs2-rescue units on this host. Returns [ok, data, units, error]. */
    Map inspect(def server) {
        Map r = exec(server, root(server,
            "${SCRIPT} inspect --json; echo; echo GR-UNITS-BEGIN; " +
            "systemctl list-units 'gfs2-rescue-*' --all --no-legend --plain 2>/dev/null; echo GR-UNITS-END"), 120)
        String out = r.out ?: ''
        String json = out.readLines().find { it.trim().startsWith('{') }
        if (!json) return [ok: false, error: "no inspect output (${r.error ?: out.take(200)})".toString()]
        Map data
        try { data = new JsonSlurper().parseText(json.trim()) as Map }
        catch (e) { return [ok: false, error: "bad inspect output: ${e.message}".toString()] }
        List<String> active = []
        boolean inUnits = false
        out.readLines().each { String l ->
            if (l.startsWith('GR-UNITS-BEGIN')) { inUnits = true; return }
            if (l.startsWith('GR-UNITS-END')) { inUnits = false; return }
            if (inUnits) {
                def f = l.trim().split(/\s+/)
                // UNIT LOAD ACTIVE SUB ...
                if (f.size() >= 3 && f[0].startsWith('gfs2-rescue-') && (f[2] == 'active' || f[2] == 'activating'))
                    active << f[0].replaceAll(/\.service$/, '').substring('gfs2-rescue-'.length())
            }
        }
        return [ok: true, data: data, units: active]
    }

    /** State of the current run for one device on one host. */
    /**
     * fsUuid (optional, validated by the caller): when this LUN has no run of its own, continue the
     * newest run on this host that has a Collect manifest for the same filesystem. An array can give a
     * LUN a new WWID (a clone split from its parent, a volume re-presented); the filesystem, and so
     * the evidence, is still the same. The run is linked to the new WWID and the change is logged.
     */
    Map status(def server, String wwid, int logLines, String fsUuid = null) {
        String w = q(wwid)
        String adopt = fsUuid ?
            ("F=${q(fsUuid)}; if [ ! -L \"\$C\" ]; then " +
             "for d in \$(find ${RUNS} -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\\n' 2>/dev/null | sort -rn | cut -d' ' -f2-); do " +
             "[ -s \"\$d/manifest-before.tsv\" ] || continue; " +
             "if grep -qsx \"\$F\" \"\$d/fs-uuid\" || grep -qs \"^File system UUID: \$F\\\$\" \"\$d/log.md\"; then " +
             "ln -sfn \"\$d\" \"\$C\"; " +
             "printf '\\n**LUN identity changed: filesystem %s is now on %s; this run continues here.**\\n' \"\$F\" \"\$W\" >> \"\$d/log.md\"; " +
             "echo \"GR-ADOPTED=\$d\"; break; fi; done; fi; ") : ''
        String cmd = "W=${w}; C=${RUNS}/\$W.current; U=gfs2-rescue-\$W; " + adopt +
            "echo \"GR-UNIT=\$(systemctl show \$U -p ActiveState --value 2>/dev/null)\"; " +
            "if [ -L \"\$C\" ]; then R=\$(readlink -f \"\$C\"); echo \"GR-RUN=\$R\"; " +
            "[ -s \"\$R/manifest-before.tsv\" ] && echo GR-MANIFEST=yes; " +
            "echo GR-STATE-BEGIN; cat \"\$R/state.json\" 2>/dev/null; echo; echo GR-STATE-END; " +
            "echo GR-LOG-BEGIN; tail -n ${logLines} \"\$R/log.md\" 2>/dev/null; echo GR-LOG-END; fi"
        Map r = exec(server, root(server, cmd), 60)
        String out = r.out ?: ''
        Map res = [ok: r.ok || out.contains('GR-UNIT='), unit: '', run: null, manifest: false, state: null, log: '', error: r.error]
        String section = null
        StringBuilder stateBuf = new StringBuilder(), logBuf = new StringBuilder()
        out.readLines().each { String l ->
            if (section == null) {
                if (l.startsWith('GR-UNIT=')) res.unit = l.substring(8).trim()
                else if (l.startsWith('GR-ADOPTED=')) res.adoptedFrom = l.substring(11).trim()
                else if (l.startsWith('GR-RUN=')) res.run = l.substring(7).trim()
                else if (l.startsWith('GR-MANIFEST=yes')) res.manifest = true
                else if (l.startsWith('GR-STATE-BEGIN')) section = 'state'
                else if (l.startsWith('GR-LOG-BEGIN')) section = 'log'
            } else if (section == 'state') {
                if (l.startsWith('GR-STATE-END')) section = null else stateBuf.append(l).append('\n')
            } else if (section == 'log') {
                if (l.startsWith('GR-LOG-END')) section = null else logBuf.append(l).append('\n')
            }
        }
        String st = stateBuf.toString().trim()
        if (st.startsWith('{')) { try { res.state = new JsonSlurper().parseText(st) } catch (ignored) {} }
        res.log = logBuf.toString()
        res.active = res.unit in ['active', 'activating', 'reloading']
        return res
    }

    /**
     * Start one step detached (systemd-run), so a long fsck outlives the agent call.
     * args are already validated by the controller. Returns [ok, run, error].
     */
    Map start(def server, String wwid, String step, List<String> args) {
        String w = q(wwid)
        String quotedArgs = args.collect { q(it) }.join(' ')
        String newRun = "R=${RUNS}/\$W-\$(date +%Y%m%d-%H%M%S); ln -sfn \"\$R\" \"\$C\"; "
        String runLine
        if (step == 'reuuid') runLine = newRun
        else if (step == 'collect')
            // a Collect right after a successful Re-UUID keeps the same run, so its evidence stays together
            runLine = "if [ -L \"\$C\" ] && grep -q '\"step\":\"reuuid\",\"result\":\"ok\"' \"\$(readlink -f \"\$C\")/state.json\" 2>/dev/null; " +
                      "then R=\$(readlink -f \"\$C\"); else ${newRun}fi; "
        else runLine = "[ -L \"\$C\" ] || { echo GR-NORUN; exit 5; }; R=\$(readlink -f \"\$C\"); "
        // verify takes the run folder as its last positional argument
        String runArg = (step == 'verify') ? ' "$R"' : ''
        String cmd = "mkdir -p ${RUNS} && chmod 0700 ${RUNS}; W=${w}; C=${RUNS}/\$W.current; U=gfs2-rescue-\$W; " +
            "systemctl is-active --quiet \"\$U\" && { echo GR-BUSY; exit 4; }; " +
            runLine +
            "systemd-run --unit \"\$U\" --collect -p KillMode=process --setenv=RUN=\"\$R\" ${SCRIPT} ${q(step)} ${quotedArgs}${runArg} >/dev/null 2>&1 " +
            "&& echo \"GR-STARTED=\$R\" || { echo GR-START-FAILED; exit 6; }"
        Map r = exec(server, root(server, cmd), 60)
        String out = r.out ?: ''
        if (out.contains('GR-BUSY')) return [ok: false, error: 'a step is already running for this volume on that host']
        if (out.contains('GR-NORUN')) return [ok: false, error: 'no collect run exists for this volume on that host - run Collect first']
        String started = out.readLines().find { it.startsWith('GR-STARTED=') }
        if (!started) return [ok: false, error: "could not start the step: ${out.trim() ?: r.error}".toString()]
        return [ok: true, run: started.substring('GR-STARTED='.length()).trim()]
    }

    /**
     * Writes a step result that happened outside the host (Attach runs in Morpheus) into the current
     * run's log.md and state.json, so "Last step" and the log tell the whole story. Best effort.
     */
    Map record(def server, String wwid, String step, String result, String detail) {
        String d = (detail ?: '').replaceAll(/[^A-Za-z0-9 _.,:;=\/()#'-]/, '').take(200)
        String cmd = "W=${q(wwid)}; C=${RUNS}/\$W.current; [ -L \"\$C\" ] || { echo GR-NORUN; exit 0; }; " +
            "RUN=\"\$(readlink -f \"\$C\")\" ${SCRIPT} record ${q(step)} ${q(result)} ${q(d)} >/dev/null 2>&1 && echo GR-RECORDED"
        Map r = exec(server, root(server, cmd), 30)
        return [ok: r.out?.contains('GR-RECORDED') == true, error: r.error]
    }

    /** Asks the host's SCSI/iSCSI layer for new LUNs (no multipath reload). Returns [ok, error]. */
    Map rescan(def server) {
        Map r = exec(server, root(server, "${SCRIPT} rescan"), 120)
        return r.out?.contains('GR-RESCAN-OK') ? [ok: true] : [ok: false, error: (r.error ?: r.out?.trim() ?: 'no answer').toString()]
    }
}

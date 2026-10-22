package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.MorpheusContext
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import groovy.util.logging.Slf4j

import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.cert.X509Certificate
import java.time.Duration
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManager
import javax.net.ssl.X509ExtendedTrustManager

/**
 * The appliance's own REST API, used for the Attach step (adding the datastore), so nobody has to
 * open Morpheus's Add Data Store dialog - which offers "Allow Reformatting" - during a takeover.
 *
 *   GET  /api/data-store-types              -> type 'libvirt-dir-gfs2' (HPE Clustered Datastore)
 *   GET  /api/clusters/{id}/datastores      -> existing datastores (duplicate check, value format)
 *   POST /api/clusters/{id}/data-stores     -> {datastore:{name, datastoreType:{id}, active, defaultStore,
 *                                               config:{blockDevice, allowReformat:false}}}
 *
 * Field names verified on 9.1 (Oct 2026, /api/data-store-types): blockDevice (config, select),
 * defaultStore (domain, "Image Target"), allowReformat (config, "Allow Reformatting", default false).
 *
 * The bearer token comes from a Trust credential named (by numeric id or name) in the plugin
 * settings, resolved the way Argus does it (listById, then loadCredentialConfig([id: N, type: 1], [:])).
 * It is never logged or returned to the browser.
 */
@Slf4j
class MorpheusApi {

    static final String GFS2_TYPE = 'libvirt-dir-gfs2'

    final MorpheusContext morpheus
    final Settings settings
    private final HttpClient http

    MorpheusApi(MorpheusContext morpheus, Settings settings) {
        this.morpheus = morpheus
        this.settings = settings
        // Extended trust manager: the JDK does not wrap it with a hostname check, so 127.0.0.1
        // works against the appliance's own certificate (same as hvm-updater, minus that check).
        X509ExtendedTrustManager trustAll = new X509ExtendedTrustManager() {
            X509Certificate[] getAcceptedIssuers() { new X509Certificate[0] }
            void checkClientTrusted(X509Certificate[] c, String a) {}
            void checkServerTrusted(X509Certificate[] c, String a) {}
            void checkClientTrusted(X509Certificate[] c, String a, Socket s) {}
            void checkServerTrusted(X509Certificate[] c, String a, Socket s) {}
            void checkClientTrusted(X509Certificate[] c, String a, SSLEngine e) {}
            void checkServerTrusted(X509Certificate[] c, String a, SSLEngine e) {}
        }
        SSLContext ctx = SSLContext.getInstance('TLS')
        ctx.init(null, [trustAll] as TrustManager[], new java.security.SecureRandom())
        http = HttpClient.newBuilder().sslContext(ctx).connectTimeout(Duration.ofSeconds(15)).build()
    }

    /**
     * The Trust credential named in the settings, by numeric ID or by name. Any type works as long as
     * it holds the token in its password / key field (API Key type worked on 9.1, Oct 2026).
     * Returns [ok, id, name, type, error]; never reads or returns the secret.
     */
    Map credential() {
        String ref = settings.apiCredentialId()
        if (!ref) return [ok: false, error: 'set "API token credential" in the plugin settings']
        def svc = morpheus.services?.accountCredential
        if (svc == null) return [ok: false, error: 'the credential service is not available']
        try {
            def found = null
            if (ref.isLong()) {
                def r = svc.class.methods.find { it.name == 'listById' && it.parameterCount == 1 }?.invoke(svc, [ref as Long])
                found = (r instanceof Collection) ? ((Collection) r).find() : null
            } else {
                def r = svc.list(new com.morpheusdata.core.data.DataQuery().withFilter('name', ref))
                List hits = (r instanceof Collection) ? ((Collection) r).findAll { it?.name?.toString() == ref } as List : []
                if (hits.size() > 1) return [ok: false, error: "more than one Trust credential is named '${ref}': use its numeric ID".toString()]
                found = hits ? hits[0] : null
            }
            if (found == null) return [ok: false, error: "Trust credential '${ref}' not found".toString()]
            String type = null
            try { type = (found.type?.name ?: found.type?.code)?.toString() } catch (ignored) {}
            return [ok: true, id: found.id as Long, name: found.name?.toString(), type: type]
        } catch (java.lang.reflect.InvocationTargetException ite) {
            return [ok: false, error: "credential lookup failed: ${(ite.cause ?: ite).message}".toString()]
        } catch (Throwable t) {
            return [ok: false, error: (ref.isLong() ? "credential lookup failed: ${t.message}"
                                                    : "looking up '${ref}' by name failed (${t.message}): use its numeric ID").toString()]
        }
    }

    /** [ok, token, error] - never log the token. */
    Map token() {
        Map c = credential()
        if (!c.ok) return c
        Long id = c.id as Long
        try {
            def svc = morpheus.services.accountCredential
            def lcc = svc.class.methods.find { it.name == 'loadCredentialConfig' && it.parameterCount == 2 }
            def res = lcc?.invoke(svc, [id: id, type: 1], [:])
            Map data = (res instanceof Map) ? (((res as Map).data instanceof Map) ? (res as Map).data as Map : res as Map) : [:]
            String t = (data.password ?: data.token ?: data.apiKey ?: data.accessToken ?: data.secretKey)?.toString()
            if (!t) return [ok: false, error: "Trust credential '${c.name}' has no password/key value".toString()]
            return [ok: true, token: t]
        } catch (java.lang.reflect.InvocationTargetException ite) {
            return [ok: false, error: "credential lookup failed: ${(ite.cause ?: ite).message}".toString()]
        } catch (Throwable t) {
            return [ok: false, error: "credential lookup failed: ${t.message}".toString()]
        }
    }

    private Map call(String tok, String method, String path, Map body) {
        String base = (settings.applianceUrl() ?: 'https://127.0.0.1').replaceAll('/+$', '')
        def rb = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(60))
                .header('Authorization', "Bearer ${tok}").header('Accept', 'application/json')
        if (method == 'POST') rb.header('Content-Type', 'application/json').POST(HttpRequest.BodyPublishers.ofString(JsonOutput.toJson(body)))
        else rb.GET()
        HttpResponse<String> resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofString())
        Map parsed = [:]
        try { if (resp.body()) parsed = new JsonSlurper().parseText(resp.body()) as Map } catch (ignored) {}
        if (resp.statusCode() >= 400) {
            String msg = parsed.msg ?: parsed.error ?: (parsed.errors ? JsonOutput.toJson(parsed.errors) : resp.body()?.take(300))
            throw new RuntimeException("${method} ${path} -> HTTP ${resp.statusCode()}: ${msg}".toString())
        }
        return parsed
    }

    /** A datastore from the API list is an HPE Clustered (GFS2) one: by type id, or by type code. */
    static boolean isGfs2Store(Map d, Map gfs2Type) {
        def t = d.datastoreType ?: d.type
        if (t instanceof Map) return (t.id != null && t.id == gfs2Type.id) || t.code == GFS2_TYPE
        return t?.toString() == GFS2_TYPE
    }

    /** Is the API usable at all? [ok, error] */
    Map check() {
        Map t = token()
        if (!t.ok) return t
        try { call(t.token as String, 'GET', '/api/whoami', null); return [ok: true] }
        catch (Throwable e) { return [ok: false, error: e.message] }
    }

    /**
     * Adds the GFS2 volume as an HPE Clustered Datastore on the cluster. Reformatting is always off.
     * Returns [ok, datastoreId, executionId, error].
     */
    Map attach(Long clusterId, String name, String device, String wwid) {
        Map t = token()
        if (!t.ok) return t
        String tok = t.token as String
        try {
            Map types = call(tok, 'GET', '/api/data-store-types?max=500', null)
            Map type = ((types.datastoreTypes ?: []) as List<Map>).find { it.code == GFS2_TYPE }
            if (!type) return [ok: false, error: "datastore type ${GFS2_TYPE} not offered by this appliance".toString()]
            List names = ((type.optionTypes ?: []) as List<Map>).collect { it.fieldName }
            if (!names.contains('blockDevice') || !names.contains('allowReformat'))
                return [ok: false, error: "datastore type ${GFS2_TYPE} fields changed (${names.join(', ')}); refusing to guess".toString()]

            // Existing datastores: refuse if ANY datastore already uses this device (a guard), but copy
            // the blockDevice value format only from other HPE Clustered (GFS2) datastores.
            Map listed = call(tok, 'GET', "/api/clusters/${clusterId}/datastores?max=500".toString(), null)
            List<Map> stores = ((listed.datastores ?: listed.dataStores ?: []) as List<Map>)
            String blockValue = device
            for (Map d : stores) {
                Map cfg = (d.config instanceof Map) ? d.config as Map : [:]
                String bd = cfg.blockDevice?.toString()
                if (!bd) continue
                if (bd == device || bd == wwid || bd.endsWith('/' + wwid))
                    return [ok: false, error: "datastore '${d.name}' already uses this device".toString()]
                if (isGfs2Store(d, type) && !bd.startsWith('/dev/')) blockValue = wwid   // GFS2 stores here use bare WWIDs
            }
            if (stores.any { it.name?.toString()?.equalsIgnoreCase(name) })
                return [ok: false, error: "a datastore named '${name}' already exists in this cluster".toString()]

            Map payload = [datastore: [
                name         : name,
                datastoreType: [id: type.id],
                active       : true,
                defaultStore : false,
                config       : [blockDevice: blockValue, allowReformat: false]
            ]]
            Map r = call(tok, 'POST', "/api/clusters/${clusterId}/data-stores".toString(), payload)
            if (r.success == false) return [ok: false, error: (r.msg ?: r.errors ?: 'rejected by the appliance').toString()]
            log.info("GFS2 Rescue: attach requested name=${name} device=${blockValue} cluster=${clusterId} allowReformat=false")
            return [ok: true, datastoreId: (r.datastore as Map)?.id, executionId: r.executionId]
        } catch (Throwable e) {
            return [ok: false, error: e.message]
        }
    }
}

package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.AbstractClusterTabProvider
import com.morpheusdata.core.MorpheusContext
import com.morpheusdata.core.Plugin
import com.morpheusdata.model.Account
import com.morpheusdata.model.ComputeServerGroup
import com.morpheusdata.model.User
import com.morpheusdata.views.HTMLResponse
import com.morpheusdata.views.ViewModel
import groovy.util.logging.Slf4j

/**
 * Infrastructure -> Clusters -> (cluster) -> GFS2 Storage.
 * The template only carries ids in data-* attributes; everything else is loaded by
 * gfs2-rescue.js through the controller (plugin-api renders the model map as the
 * template root, so references are {{clusterId}}, not {{object.clusterId}}).
 */
@Slf4j
class Gfs2RescueClusterTabProvider extends AbstractClusterTabProvider {

    Plugin plugin
    MorpheusContext morpheusContext
    Settings settings

    Gfs2RescueClusterTabProvider(Plugin plugin, MorpheusContext morpheusContext, Settings settings) {
        this.plugin = plugin
        this.morpheusContext = morpheusContext
        this.settings = settings
    }

    @Override String getCode() { return 'gfs2-rescue-cluster-tab' }
    @Override String getName() { return 'GFS2 Storage' }
    @Override Plugin getPlugin() { return plugin }
    @Override MorpheusContext getMorpheus() { return morpheusContext }

    @Override
    Boolean show(ComputeServerGroup cluster, User user, Account account) {
        return cluster != null && settings.enabled()
    }

    @Override
    HTMLResponse renderTemplate(ComputeServerGroup cluster) {
        try {
            ViewModel<Map> model = new ViewModel<>()
            model.object = [
                clusterId  : cluster?.id ?: 0,
                clusterName: cluster?.name ?: 'Cluster',
                version    : Gfs2RescuePlugin.VERSION
            ]
            return getRenderer().renderTemplate('hbs/gfs2RescueClusterTab', model)
        } catch (e) {
            log.error("GFS2 Rescue tab failed: ${e.message}", e)
            return HTMLResponse.success('<div style="padding:20px;color:#c00">GFS2 Rescue failed to load. See the appliance log.</div>')
        }
    }
}

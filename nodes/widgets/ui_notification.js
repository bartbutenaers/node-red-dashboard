module.exports = function (RED) {
    function NotificationNode (config) {
        const node = this

        RED.nodes.createNode(this, config)

        // which ui are we rendering this widget
        const ui = RED.nodes.getNode(config.ui)

        const evts = {
            onAction: true,
            beforeSend: function (msg) {
                // backward compatibility for older labels via msg.payload
                if (typeof msg.payload !== 'undefined') {
                    statestore.set(group.getBase(), node, msg, 'title', msg.payload)
                }
                /**
                 * Dynamic Properties
                 * */
                const updates = msg.ui_update
                if (updates) {
                    if (typeof (updates.title) !== 'undefined') {
                        statestore.set(group.getBase(), node, msg, 'title', updates.title)
                    }
                }
                return msg
            }
        }

        // inform the dashboard UI that we are adding this node
        ui.register(null, null, node, config, evts)
    }
    RED.nodes.registerType('ui-notification', NotificationNode)
}

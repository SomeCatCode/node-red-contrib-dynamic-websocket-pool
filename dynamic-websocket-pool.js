module.exports = function (RED) {
    const WS = require('ws');
    const crypto = require('crypto');
    const { HttpsProxyAgent } = require('https-proxy-agent'); // npm i https-proxy-agent


    function isObject(v) { return v && typeof v === 'object' && !Buffer.isBuffer(v); }
    function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    function DynamicWebSocketMapNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const pingIntervalDefault = Number(config.pingInterval || 30000);
        const reconnectMin = Math.max(0, Number(config.reconnectMin || 1000));
        const reconnectMax = Math.max(reconnectMin, Number(config.reconnectMax || 30000));
        const timeoutMs = Math.max(0, Number(config.timeoutMs || 10000));

        /** @type {Map<string, any>} */
        const connections = new Map();

        node.status({ fill: 'grey', shape: 'dot', text: 'idle' });

        function nextBackoff(attempt) {
            const base = Math.min(reconnectMax, reconnectMin * Math.pow(2, attempt));
            const jitter = Math.floor(base * 0.25 * Math.random());
            return Math.min(reconnectMax, base + jitter);
        }

        function makeAuthHeader(username, password) {
            const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
            return `Basic ${token}`;
        }

        function parseMaybeJSON(text) {
            try {
                if (typeof text !== 'string') return text;
                const t = text.trim();
                if (!t) return text;
                if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
                    return JSON.parse(t);
                }
            } catch (_) { }
            return text;
        }

        async function openConnection(id, opts) {
            const existing = connections.get(id);
            if (existing) {
                await closeConnection(id, { remove: false, silent: true });
            }

            const url = opts.url;
            const protocols = Array.isArray(opts.protocols) ? opts.protocols : undefined;
            const headers = Object.assign({}, opts.headers || {});

            if (opts.username && typeof opts.password === 'string') {
                headers['Authorization'] = makeAuthHeader(opts.username, opts.password);
            }
            if (opts.bearerToken && !headers['Authorization']) {
                headers['Authorization'] = `Bearer ${opts.bearerToken}`;
            }
            if (opts.origin) {
                headers['Origin'] = opts.origin; // manche WAF/CDNs verlangen das
            }
            if (opts.userAgent) {
                headers['User-Agent'] = opts.userAgent;
            }

            // --- TLS/WS Optionen zentral sammeln ---
            const wsOptions = {
                headers,
                // TLS:
                rejectUnauthorized: opts.rejectUnauthorized !== false,
                ca: opts.ca,               // Buffer | string | Array
                cert: opts.cert,           // Buffer | string
                key: opts.key,             // Buffer | string
                passphrase: opts.passphrase,
                servername: opts.servername, // SNI Override (falls Hostname != Zertifikat-CN)
                // WebSocket:
                handshakeTimeout: Number(opts.handshakeTimeout || opts.timeoutMs || 0) || undefined,
                perMessageDeflate: (typeof opts.perMessageDeflate === 'boolean') ? opts.perMessageDeflate : true
            };

            // Proxy support (häufig in Unternehmensnetzen nötig)
            if (opts.proxy) {
                try { wsOptions.agent = new HttpsProxyAgent(opts.proxy); }
                catch (e) { node.warn(`invalid proxy url for ${id}: ${e.message}`); }
            }

            const record = {
                id, url, protocols, headers, opts,
                ws: null,
                pingInterval: Number(opts.pingInterval ?? pingIntervalDefault),
                pingTimer: null,
                reconnectAttempts: 0,
                manualClose: false,
                reconnectTimer: null
            };

            connections.set(id, record);
            connect(record, wsOptions);
        }

        function scheduleReconnect(rec) {
            if (rec.manualClose) return; // user closed
            clearTimeout(rec.reconnectTimer);
            const delay = nextBackoff(rec.reconnectAttempts++);
            node.status({ fill: 'yellow', shape: 'ring', text: `reconnect ${rec.id} in ${delay}ms` });
            rec.reconnectTimer = setTimeout(() => connect(rec), delay);
        }

        function setupPing(rec) {
            clearInterval(rec.pingTimer);
            if (rec.pingInterval > 0) {
                rec.pingTimer = setInterval(() => {
                    try {
                        if (rec.ws && rec.ws.readyState === WS.OPEN) {
                            rec.ws.ping();
                        }
                    } catch (_) { /* ignore */ }
                }, rec.pingInterval);
            }
        }

        function connect(rec, wsOptions) {
            try {
                const ctorOpts = wsOptions || {
                    headers: rec.headers,
                    rejectUnauthorized: rec.opts.rejectUnauthorized !== false,
                    handshakeTimeout: timeoutMs
                };

                const ws = rec.protocols
                    ? new WS(rec.url, rec.protocols, ctorOpts)
                    : new WS(rec.url, ctorOpts);

                rec.ws = ws;
                node.status({ fill: 'yellow', shape: 'dot', text: `connecting ${rec.id}` });

                const urlForMeta = rec.url;

                ws.on('open', () => {
                    rec.reconnectAttempts = 0;
                    setupPing(rec);
                    node.status({ fill: 'green', shape: 'dot', text: `open ${rec.id}` });
                    node.send({ websocketId: rec.id, topic: 'open', payload: true, meta: { url: urlForMeta } });
                });

                ws.on('message', (data, isBinary) => {
                    const payload = isBinary || Buffer.isBuffer(data) ? Buffer.from(data) : parseMaybeJSON(data.toString());
                    node.send({ websocketId: rec.id, topic: 'message', payload, meta: { url: urlForMeta } });
                });

                ws.on('close', (code, reasonBuf) => {
                    clearInterval(rec.pingTimer);
                    const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf || '');
                    node.send({ websocketId: rec.id, topic: 'close', payload: false, meta: { code, reason, url: urlForMeta } });
                    node.status({ fill: rec.manualClose ? 'grey' : 'red', shape: 'ring', text: `closed ${rec.id} (${code})` });
                    if (!rec.manualClose) scheduleReconnect(rec);
                });

                ws.on('error', (err) => {
                    node.send({ websocketId: rec.id, topic: 'error', payload: { message: err.message, code: err.code }, meta: { url: urlForMeta } });
                    // i.d.R. folgt 'close'
                });

                // 401/403/… sichtbar machen
                ws.on('unexpected-response', (req, res) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        node.send({
                            websocketId: rec.id,
                            topic: 'error',
                            payload: {
                                message: `Unexpected server response: ${res.statusCode}`,
                                statusCode: res.statusCode,
                                headers: res.headers,
                                body: body.slice(0, 2048) // truncate
                            },
                            meta: { url: rec.url }
                        });
                        node.status({ fill: 'red', shape: 'ring', text: `HTTP ${res.statusCode} on ${rec.id}` });
                    });
                });
            } catch (err) {
                node.error(`connect error for ${rec.id}: ${err.message}`);
                scheduleReconnect(rec);
            }
        }

        async function closeConnection(id, { remove = false, silent = false } = {}) {
            const rec = connections.get(id);
            if (!rec) return;
            rec.manualClose = true;
            clearTimeout(rec.reconnectTimer);
            clearInterval(rec.pingTimer);
            try {
                if (rec.ws && (rec.ws.readyState === WS.CONNECTING || rec.ws.readyState === WS.OPEN)) {
                    rec.ws.close(1000, 'closed by node-red');
                }
            } catch (_) { }
            if (remove) {
                connections.delete(id);
            }
            if (!silent) node.status({ fill: 'grey', shape: 'ring', text: `closed ${id}` });
        }

        function sendTo(id, payload) {
            const rec = connections.get(id);
            if (!rec || !rec.ws || rec.ws.readyState !== WS.OPEN) {
                node.warn(`send failed: ${id} not open`);
                return;
            }
            try {
                let data = payload;
                if (isObject(payload)) data = JSON.stringify(payload);
                rec.ws.send(data);
            } catch (err) {
                node.error(`send error for ${id}: ${err.message}`);
            }
        }

        function listState() {
            const out = {};
            for (const [id, rec] of connections.entries()) {
                let state = 'CLOSED';
                const s = rec.ws ? rec.ws.readyState : -1;
                if (s === WS.CONNECTING) state = 'CONNECTING';
                else if (s === WS.OPEN) state = 'OPEN';
                else if (s === WS.CLOSING) state = 'CLOSING';
                out[id] = {
                    url: rec.url,
                    state,
                    reconnectAttempts: rec.reconnectAttempts,
                    pingInterval: rec.pingInterval
                };
            }
            node.send({ websocketId: 'CMD', topic: 'list', payload: out });
        }

        // Handle initial connections defined in editor
        if (config.initialConnections) {
            try {
                const parsed = typeof config.initialConnections === 'string' ? JSON.parse(config.initialConnections) : config.initialConnections;
                if (parsed && typeof parsed === 'object') {
                    for (const [id, opts] of Object.entries(parsed)) {
                        if (opts && typeof opts.url === 'string') {
                            openConnection(id, opts);
                        }
                    }
                }
            } catch (e) {
                node.warn('Invalid initialConnections JSON');
            }
        }

        node.on('input', async (msg, send, done) => {
            try {
                const wsid = msg.websocketId;
                if (wsid === 'CMD') {
                    const cmd = msg.payload || {};
                    switch (cmd.action) {
                        case 'create': {
                            if (!cmd.id || !cmd.url) throw new Error('create requires id and url');
                            const opts = {
                                url: cmd.url,
                                protocols: cmd.protocols,
                                headers: cmd.headers,
                                username: cmd.username,
                                password: cmd.password,
                                rejectUnauthorized: cmd.rejectUnauthorized,
                                pingInterval: cmd.pingInterval
                            };
                            await openConnection(cmd.id, opts);
                            send({ websocketId: 'CMD', topic: 'create', payload: { id: cmd.id, url: cmd.url } });
                            break;
                        }
                        case 'close': {
                            if (!cmd.id) throw new Error('close requires id');
                            await closeConnection(cmd.id, { remove: false });
                            send({ websocketId: 'CMD', topic: 'close', payload: { id: cmd.id } });
                            break;
                        }
                        case 'delete': {
                            if (!cmd.id) throw new Error('delete requires id');
                            await closeConnection(cmd.id, { remove: true });
                            send({ websocketId: 'CMD', topic: 'delete', payload: { id: cmd.id } });
                            break;
                        }
                        case 'closeAll': {
                            for (const id of Array.from(connections.keys())) {
                                await closeConnection(id, { remove: false });
                            }
                            send({ websocketId: 'CMD', topic: 'closeAll', payload: true });
                            break;
                        }
                        case 'list':
                        default:
                            listState();
                    }
                } else if (typeof wsid === 'string' && wsid) {
                    sendTo(wsid, msg.payload);
                } else {
                    node.warn('Missing websocketId (or use websocketId = \"CMD\" for management).');
                }
                done();
            } catch (err) {
                node.error(err.message, msg);
                if (done) done(err);
            }
        });

        node.on('close', async (removed, done) => {
            try {
                for (const id of Array.from(connections.keys())) {
                    await closeConnection(id, { remove: true, silent: true });
                }
            } catch (_) { }
            done();
        });
    }

    RED.nodes.registerType('dynamic-websocket-pool', DynamicWebSocketMapNode);
};

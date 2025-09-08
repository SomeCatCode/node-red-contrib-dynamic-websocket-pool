# node-red-contrib-dynamic-websocket-pool

Eine Node-RED-Node, um **dynamisch mehrere WebSocket-Verbindungen** aufzubauen, zu verwalten und gezielt (oder per Broadcast) Nachrichten zu senden.

## Features
- Verbindungen **on-the-fly** erstellen/schließen
- **Adressierbar** per `id` (einzelne, mehrere, oder `*` für alle)
- Auto-Reconnect mit Backoff, optional Heartbeat/Ping
- Text & Binär, optionale Protokolle/Headers/TLS
- Separater **Status-Output** (open/close/error)

## Installation
```bash
# im Node-RED Container/Host
npm i node-red-contrib-dynamic-websocket-pool
# oder Palette: "dynamic websocket pool" suchen
```
Node-RED neu starten.

## Node-Konzept (kurz)
- **Eingang**: Steuer-/Daten-Messages
- **Ausgänge**:
  1) Eingehende WS-Nachrichten (`msg.payload`)
  2) Status/Ereignisse (`msg.event`, `msg.id`, `msg.code`, `msg.reason`)

## Message-API

### Verbindungen steuern
```js
// erstellen
msg.websocketId = "CMD";
msg.payload = {
  action: "create",
  id: "wallbox-42",
  url: "ws://example.org/ocpp/CP42",
};
return msg;

// schließen
msg.websocketId = "CMD";
msg.payload = { 
    action: "delete", 
    id: "wallbox-42" 
};
return msg;

// alle anzeigen
msg.websocketId = "CMD";
msg.payload = { action: "list" };
return msg;
```

### Senden
```js
// an eine Verbindung
msg.websocketId = "wallbox-42";
msg.payload = "hello";
return msg;
```

## Kompatibilität
- Getestet mit Node-RED ≥ 3.x, Node.js ≥ 18
- Läuft in Docker/K8s; keine persistenten Verbindungen über Neustarts

## Lizenz
MIT
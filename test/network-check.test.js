const test = require("node:test");
const assert = require("node:assert/strict");
const check = require("../lib/network-check");

test("macOS: reads the interface used for the service's address", () => {
  const output = "   route to: 35.253.220.11\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE>";
  assert.equal(check.parseMacRouteInterface(output), "en0");
  assert.equal(check.parseMacRouteInterface(""), null);
});

test("macOS: names only connected VPN services", () => {
  const output = [
    "Available network connection services in the current set (*=enabled):",
    '* (Connected)      4F2A-1 VPN (com.wireguard.macos) "WireGuard Home"      [VPN/com.wireguard.macos]',
    '* (Disconnected)   8C11-2 PPP --> L2TP "Office VPN"    [PPP/L2TP]'
  ].join("\n");
  assert.deepEqual(check.parseMacConnectedVpns(output), ["WireGuard Home"]);
});

test("macOS: the system's own link-local-only tunnels are not a VPN", () => {
  const systemTunnel = [{ address: "fe80::2ffb:eb35:d453:a0b7", internal: false }];
  const vpnTunnel = [{ address: "10.5.0.2", internal: false }];
  assert.equal(check.hasRoutableAddress(systemTunnel), false);
  assert.equal(check.hasRoutableAddress(vpnTunnel), true);

  const quiet = check.evaluateNetwork({ platform: "darwin", connectTimesMs: [165, 168, 170], route: { interface: "utun3", routable: false } });
  assert.equal(quiet.warnings.length, 0);
  const vpn = check.evaluateNetwork({ platform: "darwin", connectTimesMs: [180, 190, 200], route: { interface: "utun4", routable: true } });
  assert.deepEqual(vpn.warnings.map((w) => w.kind), ["vpn"]);
});

test("Windows: parses the route JSON and recognises VPN adapters", () => {
  const nordlynx = check.parseWindowsRoute('{"alias":"NordLynx","name":"NordLynx","description":"NordLynx Tunnel","vpns":[]}');
  assert.equal(nordlynx.interface, "NordLynx");
  assert.deepEqual(check.evaluateNetwork({ platform: "win32", connectTimesMs: [150, 160, 170], route: nordlynx }).warnings.map((w) => w.kind), ["vpn"]);

  const wireguard = check.parseWindowsRoute('{"alias":"wg0","name":"wg0","description":"WireGuard Tunnel","vpns":null}');
  assert.equal(check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route: wireguard }).warnings[0].kind, "vpn");

  const builtIn = check.parseWindowsRoute('{"alias":"Wi-Fi","name":"Wi-Fi","description":"Intel(R) Wi-Fi 6 AX201 160MHz","vpns":"Work VPN"}');
  assert.deepEqual(builtIn.vpnNames, ["Work VPN"]);
  assert.match(check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route: builtIn }).warnings[0].message, /Work VPN/);
});

test("Windows: ordinary and virtual (Hyper-V/WSL) adapters are not a VPN", () => {
  for (const json of [
    '{"alias":"Wi-Fi","name":"Wi-Fi","description":"Intel(R) Wi-Fi 6 AX201 160MHz","vpns":[]}',
    '{"alias":"Ethernet","name":"Ethernet","description":"Realtek PCIe GbE Family Controller","vpns":[]}',
    '{"alias":"vEthernet (WSL)","name":"vEthernet (WSL)","description":"Hyper-V Virtual Ethernet Adapter","vpns":[]}'
  ]) {
    assert.equal(check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route: check.parseWindowsRoute(json) }).warnings.length, 0, json);
  }
  assert.deepEqual(check.parseWindowsRoute("not json"), {});
});

test("a proxy or a slow link is a warning; no route to the service is a blocker", () => {
  const proxied = check.evaluateNetwork({ platform: "darwin", connectTimesMs: [165], proxy: "PROXY 10.0.0.1:8080" });
  assert.deepEqual(proxied.warnings.map((w) => w.kind), ["proxy"]);
  assert.equal(check.evaluateNetwork({ platform: "darwin", connectTimesMs: [165], proxy: "DIRECT" }).warnings.length, 0);

  const slow = check.evaluateNetwork({ platform: "darwin", connectTimesMs: [520, 610, 480] });
  assert.deepEqual(slow.warnings.map((w) => w.kind), ["slow"]);
  assert.equal(slow.typicalConnectMs, 520);

  const offline = check.evaluateNetwork({ platform: "darwin", dnsError: "ENOTFOUND" });
  assert.equal(offline.reachable, false);
  assert.match(offline.blockers[0].message, /ENOTFOUND/);
  const unreachable = check.evaluateNetwork({ platform: "darwin", connectTimesMs: [null, null, null] });
  assert.equal(unreachable.blockers[0].kind, "unreachable");
});

test("'Start anyway' is remembered against the same VPN, not against latency", () => {
  const a = check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route: { interface: "NordLynx", name: "NordLynx" } });
  const b = check.evaluateNetwork({ platform: "win32", connectTimesMs: [190], route: { interface: "NordLynx", name: "NordLynx" } });
  const c = check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route: { interface: "ProtonVPN", name: "ProtonVPN" } });
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
});

test("gathers real network facts on this machine without throwing", async () => {
  const result = await check.checkNetwork({ resolveProxy: async () => "DIRECT" });
  console.log(`[network-check on ${process.platform}]`, JSON.stringify(result));
  assert.equal(typeof result.reachable, "boolean");
  assert.ok(Array.isArray(result.warnings));
  assert.ok(Array.isArray(result.blockers));
});

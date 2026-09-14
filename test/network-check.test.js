const test = require("node:test");
const assert = require("node:assert/strict");
const check = require("../lib/network-check");

// Opt-in: touches the real network and OS tools. CI's Windows job sets it,
// which is the only place the Windows detection runs on real Windows.
test("real check on this machine finds the route to the service", { skip: !process.env.MIKO_REAL_NETWORK_CHECK }, async () => {
  const result = await check.checkNetwork({ resolveProxy: async () => "DIRECT" });
  console.log(`[network-check] ${process.platform}: ${JSON.stringify(result)}`);
  assert.equal(result.reachable, true, "the service should be reachable from here");
  assert.ok(JSON.parse(result.signature).route, "the check should name the interface the connection used");
  if (process.platform === "win32") {
    // Checks that PowerShell works here, not how fast: a busy runner can take
    // longer than the app's 8 s limit, which the app copes with (it caches
    // the answer and falls back to the adapter name).
    const started = Date.now();
    const gathered = await check.gatherRoute("win32", null, { windowsTimeoutMs: 30000 });
    console.log(`[network-check] PowerShell (${Date.now() - started} ms): ${JSON.stringify(gathered)}`);
    assert.ok(gathered.adapters?.length, "PowerShell should list the network adapters");
  }
});

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

test("macOS: the route lookup wins, and the test connection fills in when it's missing", () => {
  const interfaces = { en0: [{ address: "192.168.1.106", internal: false }], utun4: [{ address: "10.5.0.2", internal: false }] };
  assert.equal(check.completeRoute({ interface: "en0" }, "utun4", interfaces).interface, "en0");
  const fallback = check.completeRoute({}, "utun4", interfaces);
  assert.deepEqual([fallback.interface, fallback.routable], ["utun4", true]);
});

test("finds the interface a connection used from its local address", () => {
  const interfaces = {
    "Wi-Fi": [{ address: "192.168.1.100", internal: false }],
    NordLynx: [{ address: "10.5.0.2", internal: false }],
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", internal: true }]
  };
  assert.equal(check.interfaceForAddress("10.5.0.2", interfaces), "NordLynx");
  assert.equal(check.interfaceForAddress("::ffff:192.168.1.100", interfaces), "Wi-Fi");
  assert.equal(check.interfaceForAddress("172.16.0.9", interfaces), null);
  assert.equal(check.interfaceForAddress(null, interfaces), null);
});

test("Windows: reads PowerShell's adapter list, including its 5.1 JSON quirks", () => {
  const plain = check.parseWindowsAdapters('{"adapters":[{"name":"Wi-Fi","description":"Intel(R) Wi-Fi 6 AX201 160MHz"},{"name":"home","description":"WireGuard Tunnel"}],"vpns":[]}');
  assert.equal(plain.adapters.length, 2);
  assert.deepEqual(plain.vpnNames, []);

  const single = check.parseWindowsAdapters('{"adapters":{"name":"Ethernet","description":"Realtek PCIe GbE Family Controller"},"vpns":"Work VPN"}');
  assert.deepEqual(single.adapters, [{ name: "Ethernet", description: "Realtek PCIe GbE Family Controller" }]);
  assert.deepEqual(single.vpnNames, ["Work VPN"]);

  const wrapped = check.parseWindowsAdapters('{"adapters":{"value":[{"name":"Ethernet","description":"x"}],"Count":1},"vpns":{"value":[],"Count":0}}');
  assert.equal(wrapped.adapters[0].name, "Ethernet");
  assert.deepEqual(wrapped.vpnNames, []);

  assert.deepEqual(check.parseWindowsAdapters("not json"), {});
  assert.deepEqual(check.parseWindowsAdapters(""), {});
});

test("Windows: recognises VPN adapters by name or description, and built-in VPNs", () => {
  const adapters = [
    { name: "Wi-Fi", description: "Intel(R) Wi-Fi 6 AX201 160MHz" },
    { name: "NordLynx", description: "NordLynx Tunnel" },
    { name: "home", description: "WireGuard Tunnel" }
  ];
  const warnings = (route) => check.evaluateNetwork({ platform: "win32", connectTimesMs: [150, 160, 170], route }).warnings;

  assert.deepEqual(warnings(check.completeRoute({ adapters }, "NordLynx", {})).map((w) => w.kind), ["vpn"]);
  assert.equal(warnings(check.completeRoute({ adapters }, "home", {}))[0].kind, "vpn", "a WireGuard tunnel named after its config is caught by its description");
  // PowerShell timed out: the adapter name alone still catches well-known clients.
  assert.equal(warnings(check.completeRoute({}, "ProtonVPN", {}))[0].kind, "vpn");
  assert.match(warnings(check.completeRoute({ adapters, vpnNames: ["Work VPN"] }, "Wi-Fi", {}))[0].message, /Work VPN/);
});

test("Windows: ordinary and virtual (Hyper-V/WSL) adapters are not a VPN", () => {
  const adapters = [
    { name: "Wi-Fi", description: "Intel(R) Wi-Fi 6 AX201 160MHz" },
    { name: "Ethernet", description: "Realtek PCIe GbE Family Controller" },
    { name: "vEthernet (WSL)", description: "Hyper-V Virtual Ethernet Adapter" }
  ];
  for (const { name } of adapters) {
    const route = check.completeRoute({ adapters, vpnNames: [] }, name, {});
    assert.equal(check.evaluateNetwork({ platform: "win32", connectTimesMs: [150], route }).warnings.length, 0, name);
  }
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

test("Windows: PowerShell's answer is reused, and asked again for an adapter it hasn't seen", async () => {
  let queries = 0;
  let clock = 0;
  let answer = { adapters: [{ name: "Wi-Fi", description: "Intel(R) Wi-Fi 6 AX201 160MHz" }], vpnNames: [] };
  const source = check.createWindowsAdapterSource({ query: async () => { queries += 1; return answer; }, now: () => clock });

  assert.deepEqual(await source.get("Wi-Fi"), answer);
  await source.get("Wi-Fi");
  source.prefetch();
  assert.equal(queries, 1, "a fresh answer is reused");

  answer = { adapters: [...answer.adapters, { name: "home", description: "WireGuard Tunnel" }], vpnNames: [] };
  assert.equal((await source.get("home")).adapters.length, 2, "a VPN adapter that just appeared is looked up");
  assert.equal(queries, 2);

  clock += 6 * 60 * 1000;
  await source.get("Wi-Fi");
  assert.equal(queries, 3, "an answer older than five minutes is refreshed");
});

test("Windows: checks at the same time share one PowerShell run, and a failed run keeps the last good answer", async () => {
  let queries = 0;
  let release;
  const shared = check.createWindowsAdapterSource({
    query: () => { queries += 1; return new Promise((resolve) => { release = resolve; }); },
    now: () => 0
  });
  const first = shared.get("Wi-Fi");
  const second = shared.get("Wi-Fi");
  release({ adapters: [{ name: "Wi-Fi", description: "x" }], vpnNames: [] });
  assert.deepEqual(await first, await second);
  assert.equal(queries, 1);

  const results = [{ adapters: [{ name: "Wi-Fi", description: "x" }], vpnNames: [] }, {}];
  const flaky = check.createWindowsAdapterSource({ query: async () => results.shift(), now: () => 0 });
  await flaky.get("Wi-Fi");
  const afterFailure = await flaky.get("Ethernet");
  assert.deepEqual(afterFailure.adapters.map((a) => a.name), ["Wi-Fi"], "PowerShell timing out keeps the last good answer");
});

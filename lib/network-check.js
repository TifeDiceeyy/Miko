// Pre-connect check (main process only). Finds things on the user's own
// machine that commonly block or degrade the live session: a VPN, a proxy,
// no route to the service, or a slow link. It only reports; it never
// changes any network setting or stops any program.
const { execFile } = require("node:child_process");
const dns = require("node:dns").promises;
const net = require("node:net");
const os = require("node:os");

const REALTIME_HOST = "fal.run";
const SLOW_CONNECT_MS = 400;
const COMMAND_TIMEOUT_MS = 4000;
// A cold PowerShell 5.1 start plus the network modules can take several
// seconds. It runs alongside the connection test, so this is a ceiling, not
// a wait.
const WINDOWS_COMMAND_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 3000;

// macOS keeps several utun interfaces for its own services, but those only
// carry link-local addresses; a VPN's tunnel has a real one. So a tunnel only
// counts when traffic to the service goes through it and it has a routable
// address.
const TUNNEL_INTERFACE = /^(utun|ipsec|ppp|tun|tap|wg)\d*$/i;

// Windows adapters (name or description) that belong to VPN clients. Kept
// specific so Hyper-V / WSL / VirtualBox virtual adapters don't match.
const VPN_ADAPTER = /wireguard|wintun|tap-windows|openvpn|nordlynx|nordvpn|proton ?vpn|mullvad|expressvpn|surfshark|windscribe|anyconnect|globalprotect|pangp|fortinet|forticlient|juniper|pulse secure|sonicwall|zscaler|cloudflare warp|hotspot shield|private internet access|tunnelbear|ipvanish|cyberghost|\bvpn\b/i;

function parseMacRouteInterface(output) {
  const match = /interface:\s*(\S+)/.exec(String(output || ""));
  return match ? match[1] : null;
}

function parseMacConnectedVpns(output) {
  const names = [];
  for (const line of String(output || "").split("\n")) {
    if (!/\(Connected\)/.test(line)) continue;
    const name = /"([^"]+)"/.exec(line);
    if (name) names.push(name[1]);
  }
  return names;
}

// PowerShell 5.1 sometimes writes an array as {"value":[...],"Count":n}, and
// a one-item array as the bare item.
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.value)) return value.value;
  return value ? [value] : [];
}

function parseWindowsAdapters(output) {
  try {
    const data = JSON.parse(String(output || "").trim());
    return {
      adapters: asList(data.adapters)
        .filter((adapter) => adapter && adapter.name)
        .map((adapter) => ({ name: String(adapter.name), description: adapter.description ? String(adapter.description) : null })),
      vpnNames: asList(data.vpns).filter(Boolean).map(String)
    };
  } catch {
    return {};
  }
}

function hasRoutableAddress(addresses = []) {
  return addresses.some((entry) => !entry.internal && !/^fe80:/i.test(entry.address) && !/^169\.254\./.test(entry.address));
}

// The interface the OS really used for the test connection to the service:
// the connection's local address belongs to it. Same on every platform, and
// no shell command involved.
function interfaceForAddress(address, interfaces = os.networkInterfaces()) {
  if (!address) return null;
  const plain = String(address).replace(/^::ffff:/i, "").replace(/%.*$/, "");
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if ((entries || []).some((entry) => entry.address === plain)) return name;
  }
  return null;
}

// Combines what the OS tools reported with the interface the test connection
// used. The macOS route lookup wins when it answered.
function completeRoute(gathered = {}, usedInterface = null, interfaces = os.networkInterfaces()) {
  const iface = gathered.interface || usedInterface || null;
  const adapter = (gathered.adapters || []).find((entry) => entry.name === iface);
  return {
    interface: iface,
    name: iface,
    description: adapter?.description || null,
    routable: hasRoutableAddress((iface && interfaces[iface]) || []),
    vpnNames: gathered.vpnNames || []
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function evaluateNetwork({ platform, dnsError = null, connectTimesMs = [], route = {}, proxy = null }) {
  const blockers = [];
  const warnings = [];
  const successes = connectTimesMs.filter((ms) => Number.isFinite(ms));

  if (dnsError) {
    blockers.push({
      kind: "offline",
      message: `Miko can't find its service on this network (${dnsError}). Check your internet connection, VPN or firewall, then press Check again.`
    });
  } else if (connectTimesMs.length && successes.length === 0) {
    blockers.push({
      kind: "unreachable",
      message: "Miko's service didn't answer. Your internet connection, a VPN or a firewall may be blocking it. Check them, then press Check again."
    });
  }

  const vpnNames = route.vpnNames || [];
  const routedThroughVpn = platform === "win32"
    ? VPN_ADAPTER.test(`${route.name || ""} ${route.description || ""} ${route.interface || ""}`)
    : Boolean(route.interface && TUNNEL_INTERFACE.test(route.interface) && route.routable);
  if (routedThroughVpn || vpnNames.length) {
    const label = vpnNames[0] || route.name || route.interface || route.description || null;
    warnings.push({
      kind: "vpn",
      label,
      message: `A VPN appears to be on${label ? ` (${label})` : ""}. VPNs often block Miko's live video or add lag. Turn it off, then press Check again.`
    });
  }

  if (proxy && proxy.trim().toUpperCase() !== "DIRECT") {
    warnings.push({
      kind: "proxy",
      message: `Your system sends Miko's connection through a proxy (${proxy.trim()}). Proxies often break live video. Turn the proxy off or allow a direct connection, then press Check again.`
    });
  }

  const typicalConnectMs = median(successes);
  if (typicalConnectMs != null && typicalConnectMs > SLOW_CONNECT_MS) {
    warnings.push({
      kind: "slow",
      message: `Your connection to Miko's service is slow right now (about ${Math.round(typicalConnectMs)} ms; under ${SLOW_CONNECT_MS} ms works best). The swap may lag or drop.`
    });
  }

  // What "Start anyway" is remembered against: the same VPN/proxy/route.
  const signature = JSON.stringify({
    kinds: warnings.map((warning) => warning.kind),
    vpn: warnings.find((warning) => warning.kind === "vpn")?.label || null,
    proxy: proxy || null,
    route: route.interface || null
  });

  return { reachable: blockers.length === 0, blockers, warnings, signature, typicalConnectMs };
}

function run(file, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

function measureConnect(host, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (ms) => {
      const localAddress = socket.localAddress || null;
      socket.destroy();
      resolve({ ms, localAddress });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(null));
    socket.once("connect", () => finish(Date.now() - started));
    socket.once("error", () => finish(null));
  });
}

async function gatherRoute(platform, ip) {
  if (platform === "darwin") {
    if (!net.isIP(ip)) return {};
    const [routeOutput, vpnOutput] = await Promise.all([run("route", ["-n", "get", ip]), run("scutil", ["--nc", "list"])]);
    return { interface: parseMacRouteInterface(routeOutput), vpnNames: parseMacConnectedVpns(vpnOutput) };
  }
  if (platform === "win32") {
    // Which interface carries the traffic comes from the test connection
    // (interfaceForAddress). PowerShell only adds adapter descriptions, to
    // recognise VPN adapters with plain names, and connected built-in VPNs.
    // Nothing from the network goes into the command.
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$a = @(Get-NetAdapter | ForEach-Object { [pscustomobject]@{ name = $_.Name; description = $_.InterfaceDescription } })",
      "$v = @((@(Get-VpnConnection) + @(Get-VpnConnection -AllUserConnection)) | Where-Object { $_.ConnectionStatus -eq 'Connected' } | ForEach-Object { $_.Name })",
      "[pscustomobject]@{ adapters = $a; vpns = $v } | ConvertTo-Json -Compress -Depth 3"
    ].join("; ");
    return parseWindowsAdapters(await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      WINDOWS_COMMAND_TIMEOUT_MS
    ));
  }
  return {};
}

async function checkNetwork({ resolveProxy = null, platform = process.platform } = {}) {
  let ip = null;
  let dnsError = null;
  try {
    ip = (await dns.lookup(REALTIME_HOST)).address;
  } catch (error) {
    dnsError = error.code || error.message;
  }

  const measure = async () => {
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await measureConnect(ip));
    return results;
  };
  const [connects, gathered, proxy] = await Promise.all([
    ip ? measure() : [],
    ip ? gatherRoute(platform, ip).catch(() => ({})) : {},
    resolveProxy ? Promise.resolve(resolveProxy(`https://${REALTIME_HOST}`)).catch(() => null) : null
  ]);
  const used = connects.find((result) => result.ms != null && result.localAddress);
  const route = completeRoute(gathered, interfaceForAddress(used?.localAddress));
  return evaluateNetwork({ platform, dnsError, connectTimesMs: connects.map((result) => result.ms), route, proxy });
}

module.exports = {
  SLOW_CONNECT_MS,
  checkNetwork,
  completeRoute,
  evaluateNetwork,
  gatherRoute,
  hasRoutableAddress,
  interfaceForAddress,
  parseMacConnectedVpns,
  parseMacRouteInterface,
  parseWindowsAdapters
};

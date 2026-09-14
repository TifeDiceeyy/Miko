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

function parseWindowsRoute(output) {
  try {
    const data = JSON.parse(String(output || "").trim());
    const vpns = Array.isArray(data.vpns) ? data.vpns : data.vpns ? [data.vpns] : [];
    return {
      interface: data.alias || null,
      name: data.name || null,
      description: data.description || null,
      vpnNames: vpns.filter(Boolean).map(String)
    };
  } catch {
    return {};
  }
}

function hasRoutableAddress(addresses = []) {
  return addresses.some((entry) => !entry.internal && !/^fe80:/i.test(entry.address) && !/^169\.254\./.test(entry.address));
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

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

function measureConnect(host, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(null));
    socket.once("connect", () => finish(Date.now() - started));
    socket.once("error", () => finish(null));
  });
}

async function gatherRoute(platform, ip) {
  if (!net.isIP(ip)) return {};
  if (platform === "darwin") {
    const iface = parseMacRouteInterface(await run("route", ["-n", "get", ip]));
    const vpnNames = parseMacConnectedVpns(await run("scutil", ["--nc", "list"]));
    const addresses = (iface && os.networkInterfaces()[iface]) || [];
    return { interface: iface, routable: hasRoutableAddress(addresses), vpnNames };
  }
  if (platform === "win32") {
    // Find-NetRoute picks the interface Windows would actually use for this
    // address, which also catches VPNs that add 0.0.0.0/1 + 128.0.0.0/1
    // routes instead of replacing the default route.
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$r = Find-NetRoute -RemoteIPAddress '${ip}' | Where-Object { $_.InterfaceIndex } | Select-Object -First 1`,
      "$a = if ($r) { Get-NetAdapter -InterfaceIndex $r.InterfaceIndex } else { $null }",
      "$v = @(Get-VpnConnection | Where-Object { $_.ConnectionStatus -eq 'Connected' } | ForEach-Object { $_.Name })",
      "[pscustomobject]@{ alias = $r.InterfaceAlias; name = $a.Name; description = $a.InterfaceDescription; vpns = $v } | ConvertTo-Json -Compress"
    ].join("; ");
    return parseWindowsRoute(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]));
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
    const times = [];
    for (let i = 0; i < 3; i += 1) times.push(await measureConnect(ip));
    return times;
  };
  const [connectTimesMs, route, proxy] = await Promise.all([
    ip ? measure() : [],
    ip ? gatherRoute(platform, ip).catch(() => ({})) : {},
    resolveProxy ? Promise.resolve(resolveProxy(`https://${REALTIME_HOST}`)).catch(() => null) : null
  ]);
  return evaluateNetwork({ platform, dnsError, connectTimesMs, route, proxy });
}

module.exports = {
  SLOW_CONNECT_MS,
  checkNetwork,
  evaluateNetwork,
  hasRoutableAddress,
  parseMacConnectedVpns,
  parseMacRouteInterface,
  parseWindowsRoute
};

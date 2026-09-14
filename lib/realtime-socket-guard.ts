// fal SDK 1.10.1 can leave a realtime socket running after its connection is
// closed: close() only shuts a socket the SDK already tracks as open, so one
// still mid-handshake survives and, once open, sends the queued prompt and
// starts a billed session nobody sees. This wrapper ties every fal realtime
// socket to the connection attempt whose token opened it, closes the sockets
// of ended attempts (even mid-handshake), and allows at most one at a time.

const REALTIME_HOST = "fal.run";

export interface RealtimeSocketGuard {
  beginAttempt(): number;
  endAttempt(ticket: number): void;
  isActive(ticket: number): boolean;
  claimToken(token: string, ticket: number): void;
  liveSocketCount(): number;
}

export function createRealtimeSocketGuard(
  NativeWebSocket: typeof WebSocket | undefined,
  report: (message: string) => void = () => {}
): { guard: RealtimeSocketGuard; GuardedWebSocket: typeof WebSocket | undefined } {
  let nextTicket = 0;
  let activeTicket: number | null = null;
  const tokenOwners = new Map<string, number>();
  const sockets = new Map<WebSocket, number | null>();
  const CLOSING = NativeWebSocket?.CLOSING ?? 2;

  function closeSocket(socket: WebSocket, message: string) {
    if (socket.readyState >= CLOSING) return;
    try {
      socket.close();
    } catch {
      // A socket that fails to close is already failing on its own.
    }
    report(message);
  }

  const guard: RealtimeSocketGuard = {
    beginAttempt() {
      const ticket = ++nextTicket;
      activeTicket = ticket;
      for (const [socket, owner] of sockets) {
        if (owner !== ticket) closeSocket(socket, "Closed a leftover realtime socket before starting a new connection");
      }
      return ticket;
    },
    endAttempt(ticket) {
      if (activeTicket === ticket) activeTicket = null;
      for (const [token, owner] of tokenOwners) {
        if (owner === ticket) tokenOwners.delete(token);
      }
      for (const [socket, owner] of sockets) {
        if (owner === ticket || owner === null) {
          closeSocket(socket, "Closed a realtime socket that was still open after its connection ended");
        }
      }
    },
    isActive: (ticket) => ticket === activeTicket,
    claimToken(token, ticket) {
      if (ticket === activeTicket) tokenOwners.set(token, ticket);
    },
    liveSocketCount() {
      let count = 0;
      for (const socket of sockets.keys()) if (socket.readyState < CLOSING) count += 1;
      return count;
    },
  };

  if (!NativeWebSocket) return { guard, GuardedWebSocket: undefined };

  class GuardedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      let parsed: URL | null = null;
      try {
        parsed = new URL(String(url));
      } catch {
        parsed = null;
      }
      if (parsed?.hostname !== REALTIME_HOST) return;

      const token = parsed.searchParams.get("fal_jwt_token");
      const owner = token != null ? tokenOwners.get(token) ?? null : null;
      if (token != null) tokenOwners.delete(token);
      sockets.set(this, owner);
      this.addEventListener("close", () => sockets.delete(this));

      if (owner === null || owner !== activeTicket) {
        closeSocket(this, "Closed a realtime socket opened for an abandoned connection attempt");
        return;
      }
      for (const socket of sockets.keys()) {
        if (socket !== this) closeSocket(socket, "Closed an extra realtime socket; only one session may run at a time");
      }
    }
  }

  return { guard, GuardedWebSocket };
}

let installed: RealtimeSocketGuard | null = null;

/** Wraps the global WebSocket once; later calls return the same guard. */
export function installRealtimeSocketGuard(report?: (message: string) => void): RealtimeSocketGuard {
  if (installed) return installed;
  const target = globalThis as { WebSocket?: typeof WebSocket };
  const { guard, GuardedWebSocket } = createRealtimeSocketGuard(target.WebSocket, report);
  if (GuardedWebSocket) target.WebSocket = GuardedWebSocket;
  installed = guard;
  return guard;
}

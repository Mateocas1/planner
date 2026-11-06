// Which Firebase backend an origin talks to.
//
// Only the Vite dev and test servers (http(s) on localhost / 127.0.0.1) run
// against the throwaway `demo-calendar-app` project and its local emulators,
// so the local suite can never reach production. Every other origin is
// production, including the packaged desktop shell: WebView2 serves it from
// http://tauri.localhost and WebKitGTK (Linux) from tauri://localhost, whose
// hostname is a bare "localhost" -- hence the protocol check.
const localHosts = new Set(["localhost", "127.0.0.1"]);

export function usesEmulators(location: { protocol: string; hostname: string }): boolean {
  const web = location.protocol === "http:" || location.protocol === "https:";
  return web && localHosts.has(location.hostname);
}

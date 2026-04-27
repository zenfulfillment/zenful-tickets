import ReactDOM from "react-dom/client";
import { StrictMode } from "react";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import App from "./App";
import "./styles/index.css";

// Forward unhandled JS errors / rejections into the Rust log so they end up in
// the rotating log file alongside backend errors. Without this, frontend bugs
// would only land in DevTools and be invisible to user-shared bug reports.
window.addEventListener("error", (e) => {
  void logError(
    `uncaught error: ${e.message} at ${e.filename ?? "?"}:${e.lineno ?? 0}:${e.colno ?? 0}` +
      (e.error?.stack ? `\n${e.error.stack}` : ""),
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  const msg =
    r instanceof Error
      ? `${r.name}: ${r.message}\n${r.stack ?? ""}`
      : typeof r === "string"
        ? r
        : (() => {
            try { return JSON.stringify(r); } catch { return String(r); }
          })();
  void logError(`unhandled rejection: ${msg}`);
});

void logInfo("frontend mounted");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

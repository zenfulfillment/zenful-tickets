"use client";

// useAudioDevices — distilled from the upstream ai-elements/mic-selector
// component. We use only the hook (the upstream UI surface depended on
// shadcn Popover/Command/Dialog widgets that need theme tokens we don't
// have wired). The dropdown UI lives in src/components/MicSelector.tsx and
// uses our own Menu primitive.
//
// Behaviour matches a typical Slack/Meet/Zoom mic-picker:
//   - Loads available audio inputs without permission (labels missing)
//   - Calling loadDevices() triggers a one-shot getUserMedia to grant
//     permission, then re-enumerates with real labels
//   - Watches `devicechange` so plugging in / out devices updates the list

import { useCallback, useEffect, useState } from "react";

// `navigator.mediaDevices` is undefined in some webview contexts (notably
// macOS WKWebView when `app.macOSPrivateApi` is off). Guard every access so
// rendering the picker never throws — without this guard a single `undefined`
// dereference inside a useEffect crashes the whole React subtree (manifests
// as the Settings → Drafting white screen).
const mediaDevices = (): MediaDevices | null =>
  typeof navigator !== "undefined" && navigator.mediaDevices
    ? navigator.mediaDevices
    : null;

const UNSUPPORTED_MSG =
  "Microphone access isn't available in this build. Update the app to the latest version.";

export const useAudioDevices = () => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  const loadDevicesWithoutPermission = useCallback(async () => {
    const md = mediaDevices();
    if (!md) {
      setError(UNSUPPORTED_MSG);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const list = await md.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to get audio devices";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDevicesWithPermission = useCallback(async () => {
    if (loading) return;
    const md = mediaDevices();
    if (!md) {
      setError(UNSUPPORTED_MSG);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const tempStream = await md.getUserMedia({ audio: true });
      // Permission granted; immediately stop the temp tracks — we just
      // wanted enumerateDevices() to start returning real labels.
      for (const t of tempStream.getTracks()) t.stop();
      const list = await md.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
      setHasPermission(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to get audio devices";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    void loadDevicesWithoutPermission();
  }, [loadDevicesWithoutPermission]);

  useEffect(() => {
    const md = mediaDevices();
    if (!md) return;
    const onChange = () => {
      if (hasPermission) void loadDevicesWithPermission();
      else void loadDevicesWithoutPermission();
    };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [hasPermission, loadDevicesWithPermission, loadDevicesWithoutPermission]);

  return {
    devices,
    error,
    hasPermission,
    loadDevices: loadDevicesWithPermission,
    loading,
  };
};

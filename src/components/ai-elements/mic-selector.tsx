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

export const useAudioDevices = () => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  const loadDevicesWithoutPermission = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await navigator.mediaDevices.enumerateDevices();
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
    try {
      setLoading(true);
      setError(null);
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission granted; immediately stop the temp tracks — we just
      // wanted enumerateDevices() to start returning real labels.
      for (const t of tempStream.getTracks()) t.stop();
      const list = await navigator.mediaDevices.enumerateDevices();
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
    const onChange = () => {
      if (hasPermission) void loadDevicesWithPermission();
      else void loadDevicesWithoutPermission();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [hasPermission, loadDevicesWithPermission, loadDevicesWithoutPermission]);

  return {
    devices,
    error,
    hasPermission,
    loadDevices: loadDevicesWithPermission,
    loading,
  };
};

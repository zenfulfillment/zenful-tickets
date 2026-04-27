// MicSelector — audio-input device picker styled to match our app.
//
// Uses the `useAudioDevices` hook from the ai-elements/mic-selector module
// (which handles permission gating + devicechange listening + label-when-
// permitted) but builds the UI on our existing Menu primitive so we don't
// need shadcn's Popover/Command surfaces (they rely on theme tokens we
// haven't wired into our app's CSS).
//
// Behaviour mirrors how Slack / Meet / Zoom present mic selection:
//   - "System default" is the first option (deviceId = null)
//   - When the user grants permission, real device labels appear (otherwise
//     we get a generic list, which is normal browser-side behaviour)
//   - New devices (e.g. AirPods plugging in) show up automatically via the
//     hook's devicechange listener
//   - Selecting a device persists immediately to settings; the next mic
//     session uses the new constraint

import { useEffect } from "react";
import { Icon } from "./Icon";
import { Menu } from "./primitives";
import { Button } from "./ui/button";
import { useAudioDevices } from "./ai-elements/mic-selector";

interface MicSelectorProps {
  /** deviceId from MediaDeviceInfo, or null for "System default". */
  value: string | null;
  onChange: (deviceId: string | null) => void;
}

export function MicSelector({ value, onChange }: MicSelectorProps) {
  const { devices, hasPermission, loading, loadDevices, error } =
    useAudioDevices();

  // Trigger the permission-protected enumerate on mount so the user sees real
  // labels in the dropdown without having to open it once first. Cheap call
  // when permission was already granted in a previous session.
  useEffect(() => {
    if (!hasPermission && !loading) {
      void loadDevices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items: { value: string; label: string }[] = [
    { value: "__default__", label: "System default" },
    ...devices.map((d) => ({
      value: d.deviceId,
      label: d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`,
    })),
  ];

  // Resolve the current selection's display label.
  const selectedDevice = value
    ? devices.find((d) => d.deviceId === value)
    : undefined;
  const triggerLabel = !value
    ? "System default"
    : selectedDevice?.label
      ? selectedDevice.label
      : value
        ? "Selected microphone (offline)"
        : "Select microphone…";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <Menu
        align="right"
        value={value ?? "__default__"}
        items={items}
        onSelect={(v) => onChange(v === "__default__" ? null : (v as string))}
        trigger={
          <Button silent style={{ minWidth: 220, justifyContent: "space-between", gap: 8 }}>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 200,
                textAlign: "left",
                flex: 1,
              }}
            >
              {triggerLabel}
            </span>
            <Icon.Chevron size={10} />
          </Button>
        }
      />
      {error && (
        <span
          style={{
            font: "400 11px var(--font-text)",
            color: "#ff453a",
            maxWidth: 240,
            textAlign: "right",
          }}
        >
          {error}
        </span>
      )}
      {!hasPermission && !error && (
        <span
          style={{
            font: "400 11px var(--font-text)",
            color: "var(--fg-subtle)",
            maxWidth: 240,
            textAlign: "right",
          }}
        >
          Grant microphone access to see device names.
        </span>
      )}
    </div>
  );
}

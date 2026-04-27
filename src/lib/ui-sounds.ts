import { playSound } from "@/lib/sound-engine";
import { clickSoftSound } from "@/lib/click-soft";
import { switchOnSound } from "@/lib/switch-on";
import { switchOffSound } from "@/lib/switch-off";
import { chipLay1Sound } from "@/lib/chip-lay-1";
import { iQuestCompleteSound } from "@/lib/i-quest-complete";
import { useAppStore } from "@/store";

export type UiSound =
  | "click"
  | "switchOn"
  | "switchOff"
  | "toggle"
  | "questComplete";

const REGISTRY = {
  click: { sound: clickSoftSound, volume: 0.55 },
  switchOn: { sound: switchOnSound, volume: 0.5 },
  switchOff: { sound: switchOffSound, volume: 0.5 },
  toggle: { sound: chipLay1Sound, volume: 0.5 },
  questComplete: { sound: iQuestCompleteSound, volume: 0.7 },
} as const;

export function playUi(name: UiSound): void {
  if (!useAppStore.getState().settings.sounds) return;
  const entry = REGISTRY[name];
  void playSound(entry.sound.dataUri, { volume: entry.volume }).catch(() => {
    // Silent — autoplay restrictions before first user gesture, or decode hiccups.
  });
}

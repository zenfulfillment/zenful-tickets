// Façade over lucide-react. Keeps the existing `Icon.<Name>` namespace API so
// no call site needs to change, but every glyph now comes from a real,
// polished icon set instead of hand-drawn SVGs.

import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Edit3,
  ExternalLink,
  Flag,
  FolderOpen,
  Globe,
  Info,
  Key,
  Lock,
  Mail,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Tag,
  Terminal,
  TriangleAlert,
  Volume2,
  VolumeOff,
  X,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

interface SizeProp {
  size?: number;
}

interface ChevronProp extends SizeProp {
  dir?: "down" | "up" | "left" | "right";
}

// All icons share a consistent stroke weight to match the app's thin-line
// aesthetic. 1.6 reads as crisp at 12-16px and still reasonable at larger sizes.
const STROKE = 1.6;

function wrap(LIcon: ComponentType<LucideProps>, defaultSize: number) {
  const Component = ({ size }: SizeProp) => (
    <LIcon size={size ?? defaultSize} strokeWidth={STROKE} />
  );
  Component.displayName = `Icon(${LIcon.displayName ?? "Lucide"})`;
  return Component;
}

export const Icon = {
  Plus: wrap(Plus, 16),
  Mic: wrap(Mic, 16),
  Send: wrap(Send, 16),
  Chevron: ({ size, dir = "down" }: ChevronProp) => {
    const Comp = { down: ChevronDown, up: ChevronUp, left: ChevronLeft, right: ChevronRight }[dir];
    return <Comp size={size ?? 12} strokeWidth={STROKE + 0.2} />;
  },
  Check: wrap(Check, 14),
  Copy: wrap(Copy, 14),
  External: wrap(ExternalLink, 12),
  Sparkle: wrap(Sparkles, 14),
  Tag: wrap(Tag, 14),
  Flag: wrap(Flag, 14),
  Folder: wrap(FolderOpen, 14),
  Settings: wrap(Settings, 14),
  Lock: wrap(Lock, 14),
  Mail: wrap(Mail, 14),
  Globe: wrap(Globe, 14),
  Terminal: wrap(Terminal, 14),
  Key: wrap(Key, 14),
  Bolt: wrap(Zap, 14),
  ArrowRight: wrap(ArrowRight, 14),
  Edit: wrap(Edit3, 14),
  Refresh: wrap(RefreshCw, 14),
  Search: wrap(Search, 14),
  Info: wrap(Info, 14),
  X: wrap(X, 14),
  Alert: wrap(TriangleAlert, 14),
  Paperclip: wrap(Paperclip, 14),
  Vol: wrap(Volume2, 14),
  VolMute: wrap(VolumeOff, 14),
};

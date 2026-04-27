// React hook + helpers around the OpenRouter model catalog.
//
// The catalog is owned by the Rust side (cached under app_data_dir,
// refreshed in the background on launch / on-demand). The frontend reads
// from cache via `openrouter_models_get` and listens for hot updates via
// the `openrouter:catalog:updated` Tauri event. Loading is non-blocking:
// before the first fetch lands, `models` is an empty array and the
// picker can show a "loading…" hint. A cached snapshot from a previous
// launch is the common case after the first run.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  openrouterModelsGet,
  openrouterModelsRefresh,
  type OpenRouterCatalog,
  type OpenRouterModel,
} from "./tauri";

export type { OpenRouterCatalog, OpenRouterModel };

export interface VendorGroup {
  /** Display label, e.g. "Anthropic", "Meta", "DeepSeek". */
  vendor: string;
  /** Models in display order — sorted alphabetically by name. */
  models: OpenRouterModel[];
}

/**
 * Group models by their vendor prefix (everything before the first `/`
 * in the model id). Vendor labels are derived from the model `name`
 * field — OpenRouter formats names as `"Anthropic: Claude Sonnet 4"`,
 * so the substring before `:` is the canonical vendor label. Falls back
 * to a title-cased version of the id prefix.
 *
 * A small priority list pins the major vendors at the top of the picker;
 * everything else is alphabetical.
 */
const VENDOR_PRIORITY: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "meta-llama",
  "mistralai",
  "deepseek",
  "x-ai",
  "qwen",
];

function vendorKey(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

function vendorLabel(model: OpenRouterModel): string {
  const colon = model.name.indexOf(":");
  if (colon !== -1) return model.name.slice(0, colon).trim();
  const key = vendorKey(model.id);
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
}

export function groupByVendor(models: OpenRouterModel[]): VendorGroup[] {
  const buckets = new Map<string, { vendor: string; models: OpenRouterModel[] }>();
  for (const m of models) {
    const key = vendorKey(m.id);
    const existing = buckets.get(key);
    if (existing) {
      existing.models.push(m);
    } else {
      buckets.set(key, { vendor: vendorLabel(m), models: [m] });
    }
  }
  for (const b of buckets.values()) {
    b.models.sort((a, b) => a.name.localeCompare(b.name));
  }
  const ordered: VendorGroup[] = [];
  for (const key of VENDOR_PRIORITY) {
    const b = buckets.get(key);
    if (b) {
      ordered.push(b);
      buckets.delete(key);
    }
  }
  const remaining = Array.from(buckets.values()).sort((a, b) =>
    a.vendor.localeCompare(b.vendor),
  );
  return [...ordered, ...remaining];
}

/**
 * React hook. Returns the catalog plus a flag for "haven't loaded yet"
 * (distinct from "loaded but empty", which can happen if the user has
 * a misconfigured key). Subscribes to live updates.
 */
export function useOpenRouterCatalog(): {
  catalog: OpenRouterCatalog | null;
  loading: boolean;
  refresh: () => void;
} {
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    void openrouterModelsGet()
      .then((c) => {
        if (mounted) setCatalog(c);
      })
      .catch(() => null)
      .finally(() => {
        if (mounted) setLoading(false);
      });

    void listen<OpenRouterCatalog>("openrouter:catalog:updated", (e) => {
      if (mounted) setCatalog(e.payload);
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  return {
    catalog,
    loading,
    refresh: () => void openrouterModelsRefresh().catch(() => null),
  };
}

export function modelSupportsImage(model: OpenRouterModel | undefined): boolean {
  return !!model?.input_modalities?.includes("image");
}

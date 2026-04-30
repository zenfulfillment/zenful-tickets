import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  opencodeModelsGet,
  opencodeModelsRefresh,
  type OpenCodeCatalog,
} from "../lib/tauri";

interface GroupedModels {
  providerId: string;
  label: string;
  models: { id: string; name: string; description: string }[];
}

export function useOpenCodeCatalog() {
  const [catalog, setCatalog] = useState<OpenCodeCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await opencodeModelsRefresh();
      setCatalog(fresh);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    void opencodeModelsGet()
      .then((c) => {
        if (mounted && c) setCatalog(c);
        if (mounted) setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });

    void listen<OpenCodeCatalog>("opencode:catalog:updated", (e) => {
      if (mounted) {
        setCatalog(e.payload);
        setLoading(false);
      }
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

  const grouped: GroupedModels[] = [];
  if (catalog) {
    const allModels: { id: string; name: string; description: string }[] = [];
    for (const m of catalog.models) {
      allModels.push({ id: m.id, name: m.name, description: m.description });
    }
    allModels.sort((a, b) => a.name.localeCompare(b.name));
    grouped.push({
      providerId: "opencode",
      label: "Anomaly — OpenCode CLI",
      models: allModels,
    });
  }

  return { catalog, grouped, loading, refresh };
}

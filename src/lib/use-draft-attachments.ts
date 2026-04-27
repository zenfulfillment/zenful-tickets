import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachmentList,
  attachmentPurgeSession,
  attachmentRegisterBytes,
  attachmentRegisterPath,
  attachmentRemove,
} from "./tauri";
import { describeError, parseAppError } from "./errors";
import { notify } from "./notify";
import type { AttachmentRef } from "../types";

// Client-side mirrors of the Rust caps. We pre-validate here to fail-fast
// before sending bytes through IPC, but the backend is the ultimate source
// of truth — it'll reject anything that slips through.
//
// Keep these in sync with src-tauri/src/attachments/mod.rs constants.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PER_SESSION = 8;

export const SUPPORTED_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf",
  "xlsx", "xls", "ods",
  "docx",
  "csv", "tsv",
  "txt", "md", "log", "json", "yaml", "yml", "toml",
] as const;

export const SUPPORTED_MIME_PATTERNS: Readonly<string[]> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "text/markdown",
  "application/json",
];

/**
 * Attachment state for one drafting session. The session id is stable for
 * the lifetime of the hook — when the user finalises a draft (submits, or
 * navigates away), call `clear()` to purge both the in-memory state and the
 * on-disk session directory.
 *
 * The hook deliberately doesn't tie itself to React Router or the global
 * store — Main.tsx mounts and unmounts cleanly, and the session is a UI
 * concern that doesn't survive re-mount. If we ever want to carry
 * attachments across navigation, lift session_id into the global store.
 */
export interface UseDraftAttachmentsResult {
  sessionId: string;
  attachments: AttachmentRef[];
  /** True while at least one register/remove call is in flight. */
  busy: boolean;
  /** Add files from File or FileList — covers paste, drop-in-webview, and picker. */
  addFiles: (files: File[] | FileList) => Promise<void>;
  /** Add files via Tauri-supplied paths — covers drag-drop from Finder/Explorer. */
  addPaths: (paths: string[]) => Promise<void>;
  /** Remove a single attachment by id. */
  remove: (id: string) => Promise<void>;
  /** Purge all attachments for this session (in-memory + on-disk). */
  clear: () => Promise<void>;
}

export function useDraftAttachments(): UseDraftAttachmentsResult {
  // Generate a session id once. crypto.randomUUID is available in all modern
  // webviews including Tauri's; no polyfill needed.
  const [sessionId] = useState(() => crypto.randomUUID());
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [busy, setBusy] = useState(false);

  // Track whether the hook is still mounted so async resolutions don't try
  // to set state on an unmounted component (common when the user submits
  // mid-upload).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Best-effort cleanup on unmount: purge the session dir on the backend so
  // the user's pasted screenshots don't pile up in the cache. This is fire-
  // and-forget; the 24h sweep on next boot would catch it anyway.
  useEffect(() => {
    return () => {
      void attachmentPurgeSession(sessionId).catch(() => {});
    };
  }, [sessionId]);

  const validateClient = useCallback(
    (file: { name: string; size: number; type?: string }): string | null => {
      if (file.size === 0) return `${file.name} is empty.`;
      if (file.size > MAX_FILE_BYTES) {
        return `${file.name} is too large (${formatBytes(file.size)}). Max is ${formatBytes(MAX_FILE_BYTES)}.`;
      }
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
        return `${file.name}: unsupported file type. Try png, jpg, pdf, xlsx, docx, or csv.`;
      }
      return null;
    },
    [],
  );

  const checkCapacity = useCallback(
    (incoming: number): boolean => {
      const remaining = MAX_PER_SESSION - attachments.length;
      if (incoming > remaining) {
        notify(`Too many attachments — ${MAX_PER_SESSION} max per draft.`, {
          kind: "warning",
          description:
            remaining > 0
              ? `Adding the first ${remaining} of ${incoming}; the rest were skipped.`
              : "Remove an existing attachment first.",
        });
      }
      return remaining > 0;
    },
    [attachments.length],
  );

  const addFiles = useCallback(
    async (filesIn: File[] | FileList) => {
      const files = Array.from(filesIn);
      if (files.length === 0) return;
      if (!checkCapacity(files.length)) return;

      setBusy(true);
      try {
        const remainingSlots = MAX_PER_SESSION - attachments.length;
        const toRegister = files.slice(0, remainingSlots);

        for (const file of toRegister) {
          const reason = validateClient(file);
          if (reason) {
            notify("Couldn't attach file", { kind: "warning", description: reason });
            continue;
          }
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const ref = await attachmentRegisterBytes(sessionId, file.name, buf);
            if (mountedRef.current) {
              setAttachments((prev) => [...prev, ref]);
            }
          } catch (e) {
            const display = describeError(parseAppError(e));
            notify(display.headline, { kind: "error", description: display.description });
          }
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [attachments.length, checkCapacity, sessionId, validateClient],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (!checkCapacity(paths.length)) return;

      setBusy(true);
      try {
        const remainingSlots = MAX_PER_SESSION - attachments.length;
        const toRegister = paths.slice(0, remainingSlots);

        for (const path of toRegister) {
          // Quick client-side ext check — saves the round-trip for obvious
          // unsupported drops. Size cap is enforced by Rust since we don't
          // have a fs.stat() in the webview.
          const filename = path.split(/[\\/]/).pop() ?? path;
          const ext = (filename.split(".").pop() ?? "").toLowerCase();
          if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
            notify("Couldn't attach file", {
              kind: "warning",
              description: `${filename}: unsupported file type.`,
            });
            continue;
          }
          try {
            const ref = await attachmentRegisterPath(sessionId, path);
            if (mountedRef.current) {
              setAttachments((prev) => [...prev, ref]);
            }
          } catch (e) {
            const display = describeError(parseAppError(e));
            notify(display.headline, { kind: "error", description: display.description });
          }
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [attachments.length, checkCapacity, sessionId],
  );

  const remove = useCallback(async (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await attachmentRemove(id);
    } catch {
      // Removal failures are silent — the worst case is a leaked file in
      // the cache dir, which the periodic sweep will collect.
    }
  }, []);

  const clear = useCallback(async () => {
    setAttachments([]);
    try {
      await attachmentPurgeSession(sessionId);
    } catch {}
  }, [sessionId]);

  // Defensive: if the backend's view of the session diverges from ours
  // (it shouldn't outside crashes), reconcile on mount.
  useEffect(() => {
    void attachmentList(sessionId).then((refs) => {
      if (mountedRef.current && refs.length > 0) {
        setAttachments(refs);
      }
    }).catch(() => {});
  }, [sessionId]);

  return { sessionId, attachments, busy, addFiles, addPaths, remove, clear };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

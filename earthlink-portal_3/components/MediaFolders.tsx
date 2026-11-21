"use client";
// A job's pictures and videos as folders: 📁 Before, 📁 After, 📁 Nobody home
// (a closed door) and 📁 Other photos (ones uploaded with no pile). A folder
// opens to its pictures and videos; a tap opens one big (a video plays); each
// folder downloads as a zip, and so does the whole job, one folder per pile.
// The pile is read off where the file sits (pact/<job>/before/…) or the front
// of its name (before_…): lib/media pileOf. PACT jobs and NYCHA releases both use it.
import { useEffect, useMemo, useState } from "react";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import { countOf, isMediaName, isVideoName, mediaWords, pileOf, PILE_LABEL, type Pile } from "@/lib/media";
import Modal from "@/components/Modal";

export interface MediaItem { name: string; path: string }
const ORDER: Pile[] = ["before", "after", "noaccess", "other"];

export default function MediaFolders({ items, canEdit, onDelete, zipName, flash }: {
  items: MediaItem[];
  canEdit: boolean;
  onDelete?: (a: MediaItem) => Promise<boolean | void> | boolean | void;
  zipName: string;                     // "PO 116843" → "PO 116843 photos.zip"
  flash: (m: string) => void;
}) {
  const media = useMemo(() => items.filter((a) => a && isMediaName(a.name)), [items]);
  const piles = useMemo(() => {
    const m = new Map<Pile, MediaItem[]>();
    for (const a of media) { const p = pileOf(a); m.set(p, [...(m.get(p) || []), a]); }
    for (const [, list] of m) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [media]);
  const [open, setOpen] = useState<Set<Pile>>(new Set());
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [big, setBig] = useState<MediaItem | null>(null);
  const [zipping, setZipping] = useState<string>("");
  // a fresh link for each picture and video, an hour long
  const key = media.map((a) => a.path).join("|");
  useEffect(() => {
    if (!media.length) { setUrls({}); return; }
    let stale = false;
    sb().storage.from("docs").createSignedUrls(media.map((a) => a.path), 3600).then(({ data }) => {
      if (stale) return;
      const m: Record<string, string> = {};
      (data || []).forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl; });
      setUrls(m);
    });
    return () => { stale = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!media.length) return null;
  const toggle = (p: Pile) => setOpen((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  // the files, fetched and zipped on this phone, one folder per pile (videos and jpegs don't shrink: stored as they are)
  const download = async (which: Pile | "all") => {
    if (zipping) return;
    const list = which === "all" ? ORDER.flatMap((p) => (piles.get(p) || []).map((a) => ({ a, p }))) : (piles.get(which) || []).map((a) => ({ a, p: which }));
    if (!list.length) return;
    const base = `${zipName}${which === "all" ? " photos" : ` ${PILE_LABEL[which].toLowerCase()}`}`.replace(/[\\/:*?"<>|#%&]+/g, "-").trim();
    const fname = askFileName(`${base}.zip`);
    if (!fname) return;
    setZipping(which);
    try {
      const { data } = await sb().storage.from("docs").createSignedUrls(list.map((x) => x.a.path), 600);
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      let missed = 0;
      for (const { a, p } of list) {
        const url = (data || []).find((d) => d.path === a.path)?.signedUrl;
        const res = url ? await fetch(url).catch(() => null) : null;
        if (!res || !res.ok) { missed += 1; continue; }
        let name = `${which === "all" ? `${PILE_LABEL[p]}/` : ""}${a.name}`;
        for (let n = 2; files[name]; n++) name = name.replace(/(\.\w+)?$/, ` (${n})$1`);
        files[name] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
      }
      if (!Object.keys(files).length) { flash("Couldn't reach the photos. Check your signal and try again."); return; }
      const { zipSync } = await import("fflate");
      const zipped = zipSync(files);
      const ab = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(ab).set(zipped);
      const href = URL.createObjectURL(new Blob([ab], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = href; link.download = fname; link.click();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      flash(missed ? `Saved, but ${missed} couldn't be reached and ${missed === 1 ? "isn't" : "aren't"} in it` : "Saved ✓");
    } finally { setZipping(""); }
  };
  const tile = (a: MediaItem) => {
    const video = isVideoName(a.name);
    return (
      <div key={a.path} className="relative">
        <button type="button" className="block w-full transition-opacity active:opacity-80" onClick={() => setBig(a)} aria-label={`Open ${a.name}`}>
          {video
            ? <span className="grid h-24 w-full place-items-center rounded-sm border border-rulesoft bg-ink text-paper"><span className="text-[22px] leading-none">▶</span><span className="text-[11px]">video</span></span>
            : urls[a.path]
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={urls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" onLoad={(e) => e.currentTarget.classList.add("anim-fade")} />
              : <span className="skeleton block h-24 w-full" />}
        </button>
        {canEdit && onDelete && (
          <button type="button" className="btn-icon btn-icon-quiet absolute -right-1 -top-1 text-paper hover:bg-transparent active:bg-transparent active:text-paper" aria-label={video ? "Delete video" : "Delete photo"} onClick={async () => { const gone = await onDelete(a); if (gone !== false && big?.path === a.path) setBig(null); }}>
            <span className="rounded-sm bg-ink/70 px-1.5 text-xs">✕</span>
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="mb-3" data-media-folders>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="section-label">Photos and videos</div>
        <button type="button" className={`btn btn-ghost btn-sm${zipping === "all" ? " btn-busy" : ""}`} aria-busy={zipping === "all" || undefined} disabled={!!zipping} onClick={() => download("all")} data-zip-all>⬇ All, in folders (zip)</button>
      </div>
      {ORDER.filter((p) => p !== "other" || (piles.get(p) || []).length).map((p) => {
        const list = piles.get(p) || [];
        const c = countOf(list.map((a) => a.name));
        const isOpen = open.has(p);
        return (
          <div key={p} className="mb-1.5 rounded-sm border border-rulesoft" data-folder={p}>
            <div className="flex items-center gap-2">
              <button type="button" className="row-btn flex min-h-[44px] flex-1 items-center gap-2 px-3 py-2 text-left text-[14px]" aria-expanded={isOpen} disabled={!list.length} onClick={() => toggle(p)}>
                <span aria-hidden className={`inline-block text-[11px] transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}>▸</span>
                <span aria-hidden>📁</span>
                <b>{PILE_LABEL[p]}</b>
                <span className="text-[12px] text-inksoft">{list.length ? mediaWords(c, "en") : "empty"}</span>
              </button>
              {list.length > 0 && (
                <button type="button" className={`btn btn-ghost btn-sm mr-1${zipping === p ? " btn-busy" : ""}`} aria-busy={zipping === p || undefined} disabled={!!zipping} onClick={() => download(p)} aria-label={`Download the ${PILE_LABEL[p]} folder`}>⬇</button>
              )}
            </div>
            {isOpen && list.length > 0 && <div className="anim-open grid grid-cols-3 gap-1.5 border-t border-rulesoft p-2">{list.map(tile)}</div>}
          </div>
        );
      })}
      {big && (
        <Modal wide title={`${PILE_LABEL[pileOf(big)].replace(/ photos$/, "")} ${isVideoName(big.name) ? "video" : "photo"}`} onClose={() => setBig(null)}
          secondary={urls[big.path] ? <a className="btn btn-ghost" href={urls[big.path]} target="_blank" rel="noreferrer">Open in a new tab</a> : undefined}>
          {urls[big.path]
            ? isVideoName(big.name)
              ? <video src={urls[big.path]} controls playsInline preload="metadata" className="mx-auto max-h-[70vh] w-full rounded-sm bg-ink" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={urls[big.path]} alt={big.name} className="anim-fade mx-auto max-h-[70vh] w-auto max-w-full rounded-sm object-contain" />
            : <div className="skeleton mx-auto h-64 w-full" />}
          <div className="mt-2 truncate text-center text-[12px] text-inksoft">{big.name}</div>
        </Modal>
      )}
    </div>
  );
}

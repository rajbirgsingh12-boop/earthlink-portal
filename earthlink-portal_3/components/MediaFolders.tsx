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
  const [cantPlay, setCantPlay] = useState(""); // the video link this browser couldn't play (a fresh link tries again)
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
  // a fresh link at the tap (the one signed when the folder opened runs out
  // after an hour); the window opens on the tap itself, so a phone doesn't block it
  const openNew = async (a: MediaItem) => {
    const w = window.open("", "_blank");
    const url = (await sb().storage.from("docs").createSignedUrl(a.path, 3600)).data?.signedUrl;
    if (url && w) w.location.href = url;
    else { w?.close(); flash(`Couldn't open that ${isVideoName(a.name) ? "video" : "photo"}`); }
  };
  // the files, fetched one at a time and zipped on this phone as they come,
  // one folder per pile (videos and jpegs don't shrink: stored as they are).
  // Each file's bytes are held once, as a piece of the zip: a few big videos
  // in one copy, never two or three, so the phone's tab doesn't run out
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
      const { Zip, ZipPassThrough } = await import("fflate");
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, chunk) => { if (err) throw err; chunks.push(chunk); });
      const names = new Set<string>();
      let missed = 0;
      for (const { a, p } of list) {
        const url = (data || []).find((d) => d.path === a.path)?.signedUrl;
        const res = url ? await fetch(url).catch(() => null) : null;
        // (a video cut off halfway by a bad signal is missed, like one never reached)
        const bytes = res && res.ok ? await res.arrayBuffer().catch(() => null) : null;
        if (!bytes) { missed += 1; continue; }
        let name = `${which === "all" ? `${PILE_LABEL[p]}/` : ""}${a.name}`;
        for (let n = 2; names.has(name); n++) name = name.replace(/(\.\w+)?$/, ` (${n})$1`);
        names.add(name);
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(new Uint8Array(bytes), true);
      }
      if (!names.size) { flash("Couldn't reach the photos. Check your signal and try again."); return; }
      zip.end();
      const href = URL.createObjectURL(new Blob(chunks, { type: "application/zip" }));
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
                <button type="button" className={`btn btn-ghost btn-sm mr-1 min-w-[44px]${zipping === p ? " btn-busy" : ""}`} aria-busy={zipping === p || undefined} disabled={!!zipping} onClick={() => download(p)} aria-label={`Download the ${PILE_LABEL[p]} folder`}>⬇</button>
              )}
            </div>
            {isOpen && list.length > 0 && <div className="anim-open grid grid-cols-3 gap-1.5 border-t border-rulesoft p-2">{list.map(tile)}</div>}
          </div>
        );
      })}
      {big && (
        <Modal wide title={`${PILE_LABEL[pileOf(big)].replace(/ photos$/, "")} ${isVideoName(big.name) ? "video" : "photo"}`} onClose={() => setBig(null)}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => openNew(big)} data-open-new>Open in a new tab</button>}>
          {urls[big.path]
            ? isVideoName(big.name)
              // a video this browser can't play (a .3gp from an Android phone on a desktop) says so
              ? cantPlay === urls[big.path]
                ? <div className="grid min-h-[10rem] place-items-center rounded-sm bg-ink p-4 text-center text-[14px] text-paper" data-cant-play>This video can&apos;t play here. Open it in a new tab to save it.</div>
                : <video src={urls[big.path]} controls playsInline preload="metadata" onError={() => setCantPlay(urls[big.path])} className="mx-auto max-h-[70vh] w-full rounded-sm bg-ink" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={urls[big.path]} alt={big.name} className="anim-fade mx-auto max-h-[70vh] w-auto max-w-full rounded-sm object-contain" />
            : <div className="skeleton mx-auto h-64 w-full" />}
          <div className="mt-2 truncate text-center text-[12px] text-inksoft">{big.name}</div>
        </Modal>
      )}
    </div>
  );
}

"use client";
// Day-by-day crew schedule: pick a day, add a release, add the workers, then
// "Text crew" messages the whole crew at once (from the company number, or a
// prefilled group text on this phone), the location and the work already written.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { matches } from "@/lib/search";
import { sb } from "@/lib/supabase";
import { useProfile } from "@/lib/profile";
import { cached, onCacheUser, remember } from "@/lib/cache";
import { prettyDate, addDays, localISO } from "@/lib/docs";
import { scrollTo, stagger } from "@/lib/motion";
import Stamp from "@/components/Stamp";
import PageHeader from "@/components/PageHeader";
import Modal from "@/components/Modal";
import CardToolbar from "@/components/CardToolbar";
import { RowActions } from "@/components/ActionMenu";
import { Toast, useFlash } from "@/components/Toast";
import SendLaterPicker from "@/components/SendLaterPicker";
import TextedPhotos from "@/components/TextedPhotos";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";
import type { Contract } from "@/lib/types";
import { cleanPhone, smsHref, sendServerTexts, textMachineReady, textRows, stampRows } from "@/lib/notify";
import { normText, saveWorkerLang } from "@/lib/pactCrew";
import { crewText, langOf, LANG_LABEL, type Lang } from "@/lib/crewText";
import { spanishKnown, spanishNow, spanishWork } from "@/lib/spanish";
import { goesOnItsOwn, isLate, isQueued, prettyWhen, queueRows, sendDueNow, unqueueRows } from "@/lib/sendLater";
import LangToggle from "@/components/LangToggle";

interface Emp { id: string; name: string; trade: string; active?: boolean; phone?: string | null; lang?: string | null; }
interface RelRow { id: string; rel_number: string; location: string; contract_id: string; address?: string | null; }
// (a row with pact_job_id belongs to a PACT job; those live on the PACT calendar, not here)
interface Assign { id: string; day: string; release_id: string | null; pact_job_id?: string | null; employee_id: string; description: string; texted: boolean; address?: string | null; send_at?: string | null; }

// words from another part of the app (the texting) shown here: their dashes become plain punctuation
const plain = (s: string) => s.replace(/\s+[\u2014\u2013]\s+/g, ": ").replace(/[\u2014\u2013]/g, "-");
// a save that didn't land, and a database behind the app, in the office's words
const SAVE_FAILED = "Couldn't save. Check your signal and try again.";
const upgradeMsg = "This day can't load until the database update is run (Settings → System check)";
const addrUpgradeMsg = "The address can't be saved until the database update is run (Settings → System check)";

// the crew, the releases and the contracts as last seen on this device: painted
// at once on the next open, replaced by the database's answer one round trip later
type Lists = { emps: Emp[]; rels: RelRow[]; contracts: Contract[] };
const LISTS_KEY = "sched:lists";
// the catch-up for texts set up for later: asked once in five minutes per device
// (the stamp is shared with the PACT calendar and every tab), not on every open
const DUE_KEY = "elgc-text-due-at";
const DUE_EVERY = 5 * 60_000;
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function Schedule() {
  const router = useRouter();
  // the remembered profile paints the page at once; the confirmed one replaces it.
  // Nothing here shows money: the edit controls follow the best known role and
  // the database enforces every write regardless
  const { hint, fresh } = useProfile();
  const role = (fresh || hint)?.role || "";
  const canEdit = role === "admin" || role === "office";
  // the day is read after mount (today, or ?day= from the calendar), so the
  // first paint never shows the server's idea of today for a blink
  const [day, setDay] = useState("");
  const [emps, setEmps] = useState<Emp[]>([]);
  const [rels, setRels] = useState<RelRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [rows, setRows] = useState<Assign[]>([]);
  const [linkContract, setLinkContract] = useState("");
  const [relPickQ, setRelPickQ] = useState("");
  const [extraRels, setExtraRels] = useState<string[]>([]); // releases added to the day before anyone's assigned
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addQ, setAddQ] = useState("");
  const [descBuf, setDescBuf] = useState<Record<string, string>>({}); // per release: work description being typed
  const [addrBuf, setAddrBuf] = useState<Record<string, string>>({}); // per release: address being typed
  // the map window: which release it's picking for, the committed search, and the box being typed
  const [mapFor, setMapFor] = useState<string | null>(null);
  const [mapQ, setMapQ] = useState("");
  const [mapInput, setMapInput] = useState("");
  const { msg, flash: show } = useFlash();
  const flash = (m: string) => show(plain(m));
  const [machine, setMachine] = useState(false); // company texting number set up?
  const [sending, setSending] = useState<string | null>(null); // release currently texting
  const [laterFor, setLaterFor] = useState<string | null>(null); // release whose "send it later" picker is open
  const [onItsOwn, setOnItsOwn] = useState<boolean | null>(null);
  useEffect(() => { goesOnItsOwn().then(setOnItsOwn); }, []);
  useEffect(() => { textMachineReady().then(setMachine); }, []);
  // anything set up for later whose time has come goes out now. With the
  // timer set up it has gone already; this is the catch-up for when it
  // isn't. It waits for the page's own reads, and asks once in five minutes
  // per device, not on every open.
  useEffect(() => {
    let stop = false;
    let first: ReturnType<typeof setTimeout> | null = null;
    let every: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        if (Date.now() - Number(localStorage.getItem(DUE_KEY) || 0) < DUE_EVERY - 1000) return;
        localStorage.setItem(DUE_KEY, String(Date.now()));
      } catch { /* private mode: ask every time */ }
      const out = await sendDueNow();
      if (stop || !out) return;
      if (out.sent > 0) flash(`${out.sent} text${out.sent === 1 ? "" : "s"} that ${out.sent === 1 ? "was" : "were"} set up just went out ✓`);
      else if (out.failed > 0) flash(`${out.failed} text${out.failed === 1 ? "" : "s"} set up for earlier didn't go through: ${out.errors?.[0]?.error || "see Settings → System check"}`);
      else if (out.missed > 0) flash(`${out.missed} text${out.missed === 1 ? "" : "s"} set up for earlier didn't go out (no number, or that day has passed). The crew shows as not told`);
      if (out.sent > 0 || out.missed > 0 || out.failed > 0) load();
    };
    void load().finally(() => {
      if (stop) return;
      first = setTimeout(() => { void tick(); every = setInterval(tick, DUE_EVERY); }, 0);
    });
    return () => { stop = true; if (first) clearTimeout(first); if (every) clearInterval(every); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the database's lists have landed on this visit (a remembered copy never paints over them)
  const got = useRef(false);
  const load = async () => {
    // independent reads go out together; releases only carry the columns the
    // pickers and texts use, not attachments and money details
    const fetchRels = async () => {
      const allR: RelRow[] = [];
      for (let from = 0; ; from += 1000) { // paginated: an unranged select stops silently at 1000
        const { data: r } = await sb().from("releases").select("id,rel_number,location,contract_id,address").eq("canceled", false).order("id").range(from, from + 999);
        if (r) allR.push(...(r as RelRow[]));
        else { // address column may predate its upgrade: fall back to full rows
          const { data: r2 } = await sb().from("releases").select("*").eq("canceled", false).order("id").range(from, from + 999);
          allR.push(...((r2 || []) as RelRow[]));
          if (!r2 || r2.length < 1000) break;
          continue;
        }
        if (r.length < 1000) break;
      }
      return allR;
    };
    const [{ data: e }, allR, { data: c }] = await Promise.all([
      sb().from("employees").select("*").order("name"),
      fetchRels(),
      sb().from("contracts").select("id,number,name").order("number"),
    ]);
    const lists: Lists = {
      emps: ((e || []) as Emp[]).filter((x) => x.active !== false),
      rels: allR.sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)),
      contracts: (c || []) as Contract[],
    };
    got.current = true;
    remember(LISTS_KEY, lists);
    setEmps(lists.emps);
    setRels(lists.rels);
    setContracts(lists.contracts);
    setListsLoaded(true);
  };
  // the remembered lists paint the moment the signed-in user is known (at once
  // on a tab-to-tab move, one session read after a cold open); the database's
  // answer, already on its way, replaces them as it lands
  useBeforePaint(() => onCacheUser(() => {
    const c = cached<Lists>(LISTS_KEY);
    if (!c || got.current) return;
    setEmps(c.emps);
    setRels(c.rels);
    setContracts(c.contracts);
    setListsLoaded(true);
  }), []);
  // the calendar links here with ?day=YYYY-MM-DD; without it, today
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const d = qs.get("day") || "";
    setDay(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localISO());
    const r = qs.get("release") || "";
    if (r) setFocusRel(r);
  }, []);
  // releases a worker texted "nobody home" about, waiting for a new day
  // (RUN_ME section 21 clears the mark once the release is put on a later day)
  const [nobodyRel, setNobodyRel] = useState<Set<string>>(new Set());
  const loadNobody = async () => {
    const { data, error } = await sb().from("texted_photos").select("release_id").eq("status", "nobody").not("release_id", "is", null).limit(200);
    if (!error) setNobodyRel(new Set(((data || []) as { release_id: string }[]).map((n) => n.release_id)));
  };
  // admin and office only: the notices are theirs (the database says so too)
  useEffect(() => { if (canEdit) loadNobody(); }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["texted_photos"], () => loadNobody(), { enabled: canEdit });
  // "Give it a new day…" (and ?release= from the PACT tab): the day it was
  // missed, at its card; add it to another day from there. It waits for the
  // releases and that day's crew to load, clears a contract filter that would
  // hide it, and puts its card on the day even if nobody's on it any more.
  const [focusRel, setFocusRel] = useState("");
  const [rowsDay, setRowsDay] = useState("");
  const showRelease = (id: string, d: string) => { setDay(d); setFocusRel(id); };
  useEffect(() => {
    if (!focusRel || rels.length === 0 || rowsDay !== day) return;
    const id = focusRel;
    setFocusRel("");
    if (!rels.some((r) => r.id === id)) { flash("That release isn't on the schedule any more (it may have been canceled)"); return; }
    setLinkContract("");
    setExtraRels((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setTimeout(() => scrollTo(document.querySelector(`[data-rel-card="${id}"]`)), 250);
  }, [focusRel, rels, rowsDay, day]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDay = async (d: string) => {
    if (!d) return;
    const { data, error } = await sb().from("schedule_days").select("*").eq("day", d).order("created_at");
    if (dayRef.current !== d) return; // switched days while this was in flight
    if (error) { if (/relation|column|schema cache/i.test(error.message)) flash(upgradeMsg); setRows([]); setRowsDay(d); return; }
    setRows((data || []) as Assign[]);
    setRowsDay(d);
  };
  const dayRef = useRef(day);
  useEffect(() => { dayRef.current = day; if (!day) return; setExtraRels([]); setAddFor(null); setAddQ(""); setDescBuf({}); setAddrBuf({}); setMapFor(null); loadDay(day); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  // a schedule_days event only refreshes the day; crew/release changes reload the lists
  useLive(["schedule_days", "employees", "releases"], (changed) => {
    if (!changed || changed.some((t) => t !== "schedule_days")) load();
    loadDay(day);
  }, { skipWhileTyping: true });

  const relLabel = (r: RelRow) => {
    const c = contracts.find((x) => x.id === r.contract_id);
    return `#${r.rel_number} · ${r.location}${c ? ` · ${contractLabel(c)}` : ""}`;
  };
  const descOf = (relId: string) =>
    descBuf[relId] ?? rows.find((x) => x.release_id === relId && (x.description || "").trim())?.description ?? "";
  // the address: what's typed now → what's saved on the day's rows → the release's own address
  const addrOf = (relId: string) =>
    addrBuf[relId] ?? rows.find((x) => x.release_id === relId && (x.address || "").trim())?.address
    ?? (rels.find((r) => r.id === relId)?.address || "");
  // the street when one is known (typed, saved on the day, or read off the release PDF), the building always.
  // A Spanish-reading worker gets the work in Spanish too: Claude's translation
  // once it has answered (asked below, ahead of the tap), the glossary's until then
  const msgFor = (rel: RelRow, relId: string, who?: string, lang?: string | null) =>
    crewText({ first: who, day, street: addrOf(relId), building: rel.location, release: rel.rel_number, work: langOf(lang) === "es" ? spanishNow(descOf(relId)) : descOf(relId), lang });
  const msgForAsync = async (rel: RelRow, relId: string, who?: string, lang?: string | null) =>
    crewText({ first: who, day, street: addrOf(relId), building: rel.location, release: rel.rel_number, work: langOf(lang) === "es" ? await spanishWork(descOf(relId)) : descOf(relId), lang });
  const [, bump] = useState(0);
  useEffect(() => {
    // every work line a Spanish-reading worker on this day will get: translated now, remembered
    const want = new Set<string>();
    for (const r of rows) {
      const e = emps.find((x) => x.id === r.employee_id);
      const w = descOf(r.release_id || "").trim();
      if (r.release_id && langOf(e?.lang) === "es" && w && !spanishKnown(w)) want.add(w);
    }
    if (!want.size) return;
    const t = setTimeout(() => { Promise.all([...want].map((w) => spanishWork(w))).then(() => bump((n) => n + 1)); }, 500);
    return () => clearTimeout(t);
  }, [rows, emps, descBuf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Add worker just adds them to the day; no message goes out until Text crew
  const addingNow = useRef<Set<string>>(new Set()); // guards a double-tap on the same name
  const addWorker = async (rel: RelRow, emp: Emp) => {
    const k = `${rel.id}:${emp.id}`;
    if (addingNow.current.has(k)) return;
    if (rows.some((x) => x.release_id === rel.id && x.employee_id === emp.id)) { flash(`${emp.name} is already on this release today`); return; }
    addingNow.current.add(k);
    setTimeout(() => addingNow.current.delete(k), 4000);
    const base = { day, release_id: rel.id, employee_id: emp.id, description: descOf(rel.id).trim() };
    let { data, error } = await sb().from("schedule_days").insert({ ...base, address: addrOf(rel.id).trim() }).select().single();
    if (error && /column|schema cache/i.test(error.message)) {
      ({ data, error } = await sb().from("schedule_days").insert(base).select().single());
      if (data) flash(addrUpgradeMsg);
    }
    if (error) { flash(/relation|column|schema cache/i.test(error.message) ? upgradeMsg : SAVE_FAILED); return; }
    const row = data as Assign;
    setRows((prev) => (prev.some((x) => x.id === row.id) ? prev : [...prev, row]));
  };

  // Text crew: one tap messages the whole crew on this release. With the
  // company number set up the texts go out silently from that number;
  // otherwise it opens a group text on this phone.
  const textCrew = async (rel: RelRow) => {
    const assigned = rows.filter((x) => x.release_id === rel.id);
    const targets = assigned
      .map((row) => ({ row, emp: emps.find((e) => e.id === row.employee_id) }))
      .filter((t): t is { row: Assign; emp: Emp } => !!t.emp && !!cleanPhone(t.emp.phone || ""))
      .map((t) => ({ rowId: t.row.id, to: cleanPhone(t.emp.phone || ""), first: t.emp.name.split(" ")[0], body: msgFor(rel, rel.id, t.emp.name.split(" ")[0], t.emp.lang), lang: t.emp.lang }));
    if (targets.length === 0) { flash("No saved numbers on this crew. Add them in Settings → Crew first"); return; }
    if (!descOf(rel.id).trim() && !window.confirm("No work description yet. Send the assignments anyway?")) return;
    const stamp = async (ids: string[]) => {
      setRows((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, texted: true } : x)));
      await stampRows(ids);
    };
    setSending(rel.id);
    // the one sender every crew text goes through: row ids ride along so the
    // server stamps TEXTED itself and a retry after a dead spot skips workers
    // who were already texted; nobody gets doubled
    // the Spanish ones wait for Claude's wording (the glossary's if Claude can't answer)
    for (const t of targets) if (langOf(t.lang) === "es") t.body = await msgForAsync(rel, rel.id, t.first, t.lang);
    const out = await textRows(targets);
    setSending(null);
    if (out.status === "sent") {
      // TEXTED only goes on rows whose number actually went through (skipped
      // rows are already stamped in the database)
      const bad = new Set(out.failed.map((f) => f.to));
      const okIds = targets.filter((t) => !bad.has(t.to)).map((t) => t.rowId);
      if (okIds.length > 0) await stamp(okIds);
      flash(out.message);
    } else if (out.status === "fallback") {
      // no company number yet: a group text opened on this phone. The stamp
      // waits for the owner to confirm: the composer can be canceled (or never
      // open right on some phones), and a false TEXTED ✓ means a crew that was
      // never told.
      setTimeout(async () => {
        if (window.confirm("Did the group text send? OK stamps the crew TEXTED ✓")) await stamp(out.rowIds);
      }, 600);
    } else {
      flash(out.message);
    }
  };
  // the row menu asked first when the worker was already texted
  const unassign = async (id: string) => {
    const { error } = await sb().from("schedule_days").delete().eq("id", id);
    if (error) { flash(SAVE_FAILED); return; }
    setRows((prev) => prev.filter((x) => x.id !== id));
  };
  const markTexted = async (id: string) => {
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, texted: true } : x)));
    await sb().from("schedule_days").update({ texted: true }).eq("id", id);
  };
  // a TEXTED mark that landed without a text really going out (a group
  // message nobody sent, say) comes off here
  const clearTexted = async (id: string) => {
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, texted: false } : x)));
    await sb().from("schedule_days").update({ texted: false }).eq("id", id);
  };
  const saveDesc = async (relId: string) => {
    // untouched field = nothing typed; saving here would blank the crew's
    // saved description just for tapping in and out of the box
    if (descBuf[relId] === undefined) return;
    const desc = descBuf[relId].trim();
    const mine = rows.filter((x) => x.release_id === relId);
    const ids = mine.map((x) => x.id);
    if (ids.length === 0) return;
    // the crew was texted the OLD wording: a real change puts them back in the
    // to-send pile, otherwise Text crew skips everyone and says it sent ✓
    const resend = mine.some((x) => normText(x.description || "") !== normText(desc)) && mine.some((x) => x.texted);
    setRows((prev) => prev.map((x) => (x.release_id === relId ? { ...x, description: desc, ...(resend ? { texted: false } : {}) } : x)));
    await sb().from("schedule_days").update(resend ? { description: desc, texted: false } : { description: desc }).in("id", ids);
    if (resend) flash("Description changed. Tap Text crew again so the crew gets it");
  };
  const saveAddr = async (relId: string, value?: string) => {
    if (value === undefined && addrBuf[relId] === undefined) return; // untouched, see saveDesc
    const addr = (value ?? addrBuf[relId] ?? "").trim();
    if (value !== undefined) setAddrBuf((p) => ({ ...p, [relId]: addr }));
    const mine = rows.filter((x) => x.release_id === relId);
    const ids = mine.map((x) => x.id);
    if (ids.length === 0) return;
    // same as the description: a corrected address the crew never got told is
    // the whole reason to text again
    const resend = mine.some((x) => normText(x.address || "") !== normText(addr)) && mine.some((x) => x.texted);
    setRows((prev) => prev.map((x) => (x.release_id === relId ? { ...x, address: addr, ...(resend ? { texted: false } : {}) } : x)));
    const { error } = await sb().from("schedule_days").update(resend ? { address: addr, texted: false } : { address: addr }).in("id", ids);
    if (error && /column|schema cache/i.test(error.message)) flash(addrUpgradeMsg);
    else if (resend) flash("Address changed. Tap Text crew again so the crew gets it");
  };
  const openMap = (relId: string) => {
    const start = addrOf(relId).trim() || (rels.find((r) => r.id === relId)?.location || "");
    setMapFor(relId); setMapInput(start); setMapQ(start);
  };
  // a release picked for this day: its card opens with the add-worker box ready
  const pickRel = (id: string) => { setExtraRels((prev) => (prev.includes(id) ? prev : [...prev, id])); setRelPickQ(""); setAddFor(id); setAddQ(""); };

  // one card per release on this day (assigned rows ∪ releases just added)
  const relIds = [...new Set([...rows.map((x) => x.release_id).filter(Boolean) as string[], ...extraRels])];
  const cards = relIds
    .map((id) => rels.find((r) => r.id === id))
    .filter((r): r is RelRow => !!r)
    .filter((r) => !linkContract || r.contract_id === linkContract)
    .sort((a, b) => a.rel_number.localeCompare(b.rel_number, undefined, { numeric: true }));
  // the lists and this day's rows are both in: until then the cards shimmer
  const ready = listsLoaded && rowsDay === day;
  const todayISO = localISO();
  const header = <PageHeader title="Schedule" sub="NYCHA · crews by day" />;
  const skeletons = [0, 1, 2].map((i) => (
    <div key={`sk${i}`} className="card mb-3 p-3.5" aria-busy="true">
      <div className="flex items-center justify-between gap-2"><div className="skeleton h-4 w-28" /><div className="skeleton h-4 w-14" /></div>
      <div className="skeleton mt-3 h-11 w-full" />
      <div className="skeleton mt-2 h-4 w-40" />
    </div>
  ));

  // the day isn't known until the page has mounted
  if (!day) return <div>{header}{skeletons}</div>;

  return (
    <div>
      {header}
      {/* which day: today, tomorrow, or any date */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="seg" role="radiogroup" aria-label="Today or tomorrow">
          <button type="button" role="radio" aria-checked={day === todayISO} className="seg-item" onClick={() => setDay(todayISO)}>Today</button>
          <button type="button" role="radio" aria-checked={day === addDays(todayISO, 1)} className="seg-item" onClick={() => setDay(addDays(todayISO, 1))}>Tomorrow</button>
        </div>
        <input type="date" className="field w-44 font-mono" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </div>
      <TextedPhotos canEdit={canEdit} flash={flash} onShow={(b) => {
        // a PACT job opens on the PACT calendar without a full reload (it reads ?job= as it mounts)
        if (b.pact_job_id) { router.push(`/pact/schedule?job=${b.pact_job_id}`); return; }
        if (!b.release_id) return;
        const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(b.created_at));
        showRelease(b.release_id, d);
      }} />

      {canEdit && (
        <div className="mb-3 grid items-end gap-2 md:grid-cols-2">
          <div>
            <div className="section-label mb-1">Contract</div>
            <ContractPicker contracts={contracts} value={linkContract} onChange={setLinkContract} extra={[{ id: "", label: "All contracts" }]} />
          </div>
          <div>
            <input className="field" type="search" enterKeyHint="search" autoComplete="off" placeholder="+ Add a release to this day: release # or development"
              value={relPickQ} onChange={(e) => setRelPickQ(e.target.value)} />
            {relPickQ.trim() && (
              <div className="popover static max-h-72 overflow-y-auto">
                {rels
                  .filter((r) => !linkContract || r.contract_id === linkContract)
                  .filter((r) => relLabel(r).toLowerCase().includes(relPickQ.trim().toLowerCase()))
                  .slice(0, 40)
                  .map((r) => (
                    // the pick lands on pointer down so the box keeps its focus; the keyboard's Enter still works (a click with no pointer)
                    <button key={r.id} type="button" className="row-btn border-b border-rulesoft px-3 py-2.5 text-[14px] last:border-b-0"
                      onPointerDown={(ev) => { ev.preventDefault(); pickRel(r.id); }} onClick={(ev) => { if (ev.detail === 0) pickRel(r.id); }}>
                      {relLabel(r)}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {!ready && skeletons}
      {ready && cards.length === 0 && (
        <div className="empty mb-3">Nothing on {prettyDate(day)} yet.{canEdit ? " Add a release above, add the workers, then Text crew." : ""}</div>
      )}

      {ready && cards.map((rel) => {
        const assigned = rows.filter((x) => x.release_id === rel.id);
        const inCard = new Set(assigned.map((x) => x.employee_id));
        const q = addQ.trim().toLowerCase();
        const match = emps.filter((e) => !inCard.has(e.id)).filter((e) => matches(q, e.name));
        const contract = contracts.find((x) => x.id === rel.contract_id);
        return (
          <div key={rel.id} className="card mb-3 p-3.5" data-rel-card={rel.id}>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                {nobodyRel.has(rel.id) && <span className="mr-2" data-nobody-stamp><Stamp label="⚠ NOBODY HOME" tone="alert" /></span>}
                <b className="font-mono text-[14px]">#{rel.rel_number}</b>
                <span className="ml-2 text-[14px]">{rel.location}</span>
                {contract && <span className="ml-1.5 text-[12px] text-inksoft">· {contractLabel(contract)}</span>}
              </div>
              <span className="chip text-inksoft">{assigned.length} worker{assigned.length === 1 ? "" : "s"}</span>
            </div>
            <input className="field mb-2" placeholder="The work: what should they do there?"
              value={descBuf[rel.id] ?? descOf(rel.id)} readOnly={!canEdit}
              onChange={(e) => setDescBuf((p) => ({ ...p, [rel.id]: e.target.value }))}
              onBlur={() => canEdit && saveDesc(rel.id)} />
            <div className="mb-2 flex gap-2">
              <input className="field flex-1" placeholder="Address: where they should show up"
                value={addrBuf[rel.id] ?? addrOf(rel.id)} readOnly={!canEdit}
                onChange={(e) => setAddrBuf((p) => ({ ...p, [rel.id]: e.target.value }))}
                onBlur={() => canEdit && saveAddr(rel.id)} />
              {canEdit && <button type="button" className="btn btn-ghost shrink-0 px-3" onClick={() => openMap(rel.id)}>Map</button>}
            </div>
            {assigned.map((row, i) => {
              const emp = emps.find((e) => e.id === row.employee_id);
              if (!emp) return null;
              const ok = !!cleanPhone(emp.phone || "");
              const first = emp.name.split(" ")[0];
              return (
                <div key={row.id} className="anim-up flex flex-wrap items-center gap-2 border-t border-rulesoft py-2 first:border-t-0" style={stagger(i)}>
                  <b className="text-[14px]">{emp.name}</b>
                  <LangToggle value={langOf(emp.lang)} disabled={!canEdit} name={`Language for ${emp.name}`} onChange={async (l: Lang) => {
                    const bad = await saveWorkerLang(sb(), emp.id, l);
                    if (bad) { flash(bad); return; }
                    setEmps((prev) => prev.map((x) => (x.id === emp.id ? { ...x, lang: l } : x)));
                    flash(`${first} gets texts in ${LANG_LABEL[l]}`);
                  }} />
                  {row.texted && <Stamp label="TEXTED ✓" tone="ok" />}
                  {isQueued(row) && <Stamp label={`${isLate(row) ? "STILL WAITING · " : "GOES OUT "}${prettyWhen(row.send_at)}`} tone={isLate(row) ? "alert" : "work"} />}
                  {!row.texted && !isQueued(row) && <Stamp label="NOT TEXTED" tone="mute" />}
                  {!ok && <span className="text-[12px] text-inksoft">no number in the crew list</span>}
                  <span className="ml-auto flex items-center gap-1">
                    {ok && !machine && (
                      // their text opens on this phone; the stamp waits for the person to say it went
                      <a className="btn-link text-inksoft" href={smsHref(emp.phone || "", msgFor(rel, rel.id, first, emp.lang))}
                        onClick={() => setTimeout(() => { if (window.confirm(`Did the text to ${first} send? OK stamps TEXTED ✓`)) markTexted(row.id); }, 600)}>Resend</a>
                    )}
                    {ok && machine && canEdit && (
                      <button type="button" className="btn-link text-inksoft"
                        onClick={async () => {
                          const res = await sendServerTexts(
                            [{ to: cleanPhone(emp.phone || ""), body: await msgForAsync(rel, rel.id, first, emp.lang), id: row.id }],
                            (await sb().auth.getSession()).data.session?.access_token || null);
                          if (res.ok && (res.failed || []).length === 0) { markTexted(row.id); flash(`Texted ${first} ✓`); }
                          else flash(res.failed?.[0]?.error || res.error || "Couldn't send the text. Check your signal and try again.");
                        }}>Resend</button>
                    )}
                    {canEdit && <RowActions items={[
                      { label: "Clear TEXTED mark", hidden: !row.texted, confirm: `Clear the TEXTED mark for ${first}? Do this if the message never really went out.`, onSelect: () => void clearTexted(row.id) },
                      { label: "Remove from this day", destructive: true, confirm: row.texted ? `${first} was already texted about this job. Remove them anyway? They won't be told automatically.` : undefined, onSelect: () => void unassign(row.id) },
                    ]} />}
                  </span>
                </div>
              );
            })}
            {assigned.length === 0 && <div className="empty my-2">No one on it yet.{canEdit ? " Add workers, then Text crew." : ""}</div>}
            {canEdit && addFor === rel.id && (
              <div className="mt-2">
                <input className="field" autoFocus autoComplete="off" placeholder="Type a worker's name…" value={addQ}
                  onChange={(e) => setAddQ(e.target.value)}
                  onBlur={() => setTimeout(() => setAddFor((cur) => (cur === rel.id ? null : cur)), 150)} />
                <div className="popover static max-h-80 overflow-y-auto">
                  {match.map((e) => (
                    <button key={e.id} type="button" className="row-btn flex items-center justify-between border-b border-rulesoft px-3 py-2.5 text-[14px] last:border-b-0"
                      onPointerDown={(ev) => { ev.preventDefault(); addWorker(rel, e); setAddQ(""); }} onClick={(ev) => { if (ev.detail === 0) { addWorker(rel, e); setAddQ(""); } }}>
                      <span>{e.name}{langOf(e.lang) === "es" ? <span className="chip ml-1.5 text-inksoft">ES</span> : null}</span>
                      <span className="text-[12px] text-inksoft">{cleanPhone(e.phone || "") ? "+ add" : "+ add (no number)"}</span>
                    </button>
                  ))}
                  {match.length === 0 && <div className="p-2.5 text-[14px] text-inksoft">No one matches “{addQ}”.</div>}
                </div>
              </div>
            )}
            {canEdit && addFor !== rel.id && (() => {
              const waiting = assigned.filter((r) => isQueued(r));
              const late = waiting.length > 0 && isLate(waiting[0]);
              const setUp = async (t: Date) => {
                const ids = assigned.filter((r) => !r.texted || isQueued(r)).map((r) => r.id);
                if (ids.length === 0) { flash("Everyone here has already been texted"); return; }
                const bad = await queueRows(ids, t);
                if (bad) { flash(bad); return; }
                setLaterFor(null);
                flash(`${ids.length === 1 ? "The text goes" : `${ids.length} texts go`} out ${prettyWhen(t.toISOString())}`);
                loadDay(day);
              };
              return (
              <>
              <CardToolbar className="mt-2"
                primary={assigned.length > 0 ? (
                  <button type="button" className={`btn btn-primary${sending === rel.id ? " btn-busy" : ""}`} aria-busy={sending === rel.id || undefined} disabled={sending === rel.id} onClick={() => textCrew(rel)}>
                    {assigned.length === 1 ? "📱 Text worker" : `📱 Text crew (${assigned.length})`}
                  </button>
                ) : undefined}
                secondary={<>
                  <button type="button" className="btn btn-ghost" onClick={() => { setAddFor(rel.id); setAddQ(""); }}>Add worker</button>
                  {machine && assigned.length > 0 && laterFor !== rel.id && (
                    <button type="button" className="btn btn-ghost" data-later={rel.rel_number} onClick={() => setLaterFor(rel.id)}>Send it later…</button>
                  )}
                </>} />
              {waiting.length > 0 && (
                <div className="anim-open mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-rulesoft bg-white px-3 py-2 text-[13px]" data-later-waiting={rel.rel_number}>
                  <span>{late ? "⚠ " : "📅 "}{waiting.length === 1 ? "A text is" : `${waiting.length} texts are`} set to go out {prettyWhen(waiting.map((r) => r.send_at || "").sort()[0])}.{late ? " It hasn't gone yet." : ""}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <button type="button" className="btn-link text-inksoft" disabled={sending === rel.id} onClick={() => textCrew(rel)}>Send it now</button>
                    <button type="button" className="btn-link text-alert" onClick={async () => { const bad = await unqueueRows(waiting.map((r) => r.id)); if (bad) { flash(bad); return; } flash("The text that was set up is called off"); loadDay(day); }}>Call it off</button>
                  </span>
                </div>
              )}
              {laterFor === rel.id && <SendLaterPicker dataAttr="data-later-picker" onItsOwn={onItsOwn} onCancel={() => setLaterFor(null)} onPick={(iso) => void setUp(new Date(iso))} />}
              </>
              );
            })()}
          </div>
        );
      })}

      {!machine && (
        <div className="mt-1 text-[12px] text-inksoft">
          Texts open on this phone. To send them from a company number, see Settings → System check. Numbers come from the crew list (Settings → Crew).
        </div>
      )}

      {/* the map window: type the place, check the pin, use it. The text the
          workers get includes a tap-to-navigate Google Maps link */}
      {mapFor && (
        <Modal title="Pick the location" onClose={() => setMapFor(null)}
          primary={<button type="button" className="btn btn-primary" disabled={!mapInput.trim()} onClick={() => { saveAddr(mapFor, mapInput.trim()); setMapFor(null); }}>Use this location</button>}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => setMapFor(null)}>Cancel</button>}>
          <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); setMapQ(mapInput.trim()); }}>
            <input className="field flex-1" type="search" enterKeyHint="search" autoComplete="off" autoFocus placeholder="Type the address or place…"
              value={mapInput} onChange={(e) => setMapInput(e.target.value)} />
            <button type="submit" className="btn shrink-0">Search</button>
          </form>
          {mapQ ? (
            <iframe title="Map of the address" className="h-72 w-full rounded-sm border border-rulesoft"
              src={`https://www.google.com/maps?q=${encodeURIComponent(mapQ)}&output=embed`} />
          ) : (
            <div className="empty flex h-72 items-center justify-center">Type an address above and tap Search to see it on the map.</div>
          )}
        </Modal>
      )}
      <Toast msg={msg} />
    </div>
  );
}

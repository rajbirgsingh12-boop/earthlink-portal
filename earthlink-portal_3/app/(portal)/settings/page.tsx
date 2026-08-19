"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
// the export engine is heavy — it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { useLive } from "@/lib/useLive";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import type { Org } from "@/lib/docs";
import type { Contract, Profile, Role } from "@/lib/types";
import { PKG_DEFAULTS, type PkgInfo, loadPkgInfo, savePkgInfo } from "@/lib/packageDocs";
import { PRICE_BOOK, PRICE_GROUPS, CUSTOM_GROUP, EMPTY_STORE, blankCustom, bookFrom, loadPrices, savePrices,
  type PriceOverride, type PriceStore, type CustomItem } from "@/lib/priceBook";
import { cleanPhone, prettyPhone } from "@/lib/notify";

// the two roles: Admin 1 sees everything; Admin 2 sees everything except
// PACT invoices (internally these are the existing admin/office roles)
// how a line is measured: counted, by the square foot, or by the hour
const UNITS = ["EACH", "SF", "HOUR"];

const ROLE_OPTIONS: [Role, string][] = [
  ["admin", "Admin 1 — full access"],
  ["office", "Admin 2 — no PACT invoices"],
];

const FIELDS: [keyof Org, string][] = [
  ["company", "Company name"], ["address1", "Street address"], ["address2", "City, State ZIP"],
  ["phone", "Phone"], ["email", "Email"], ["license", "License # (shows on documents)"], ["terms", "Payment terms (e.g. Net 30)"],
];

export default function Settings() {
  const [org, setOrg] = useState<Org | null>(null);
  const [me, setMe] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Profile[]>([]);
  const [msg, setMsg] = useState("");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setMsg(""), 4000);
  };

  const loadUsers = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;
    const { data: p } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
    setMe(p as Profile);
    if ((p as Profile)?.role === "admin") {
      const { data: all } = await sb().from("profiles").select("id,name,role").order("name");
      setPeople((all || []) as Profile[]);
    }
  };
  const [contracts, setContracts] = useState<Contract[]>([]);
  useEffect(() => {
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
    loadUsers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // live: user list and contract names stay current across devices
  useLive(["profiles", "contracts"], () => {
    loadUsers();
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
  }, { skipWhileTyping: true });

  // ---- crew phone numbers (used by the Schedule tab's tap-to-text) ----
  type Emp = { id: string; name: string; trade: string; active: boolean; phone?: string | null };
  const [emps, setEmps] = useState<Emp[]>([]);
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [crewDraft, setCrewDraft] = useState({ name: "", trade: "", phone: "" });
  const loadEmps = () => sb().from("employees").select("id,name,trade,active,phone").order("name")
    .then(({ data }) => setEmps((data || []) as Emp[]));
  useEffect(() => { loadEmps(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["employees"], loadEmps, { skipWhileTyping: true });
  const savePhone = async (empId: string, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    const { error } = await sb().from("employees").update({ phone }).eq("id", empId);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql so phone numbers save" : error.message); return; }
    setEmps((prev) => prev.map((e) => (e.id === empId ? { ...e, phone } : e)));
    flash("Number saved");
  };
  const addWorker = async () => {
    if (!crewDraft.name) return;
    const row: Record<string, unknown> = { name: crewDraft.name, trade: crewDraft.trade, base_rate: 0 };
    if (crewDraft.phone.trim()) row.phone = cleanPhone(crewDraft.phone) || crewDraft.phone.trim();
    let { error } = await sb().from("employees").insert(row);
    if (error && "phone" in row && /column|schema cache/i.test(error.message)) {
      delete row.phone;
      ({ error } = await sb().from("employees").insert(row));
      if (!error) flash("Run supabase/RUN_ME.sql so phone numbers save");
    }
    if (error) { flash(error.message); return; }
    setCrewDraft({ name: "", trade: "", phone: "" }); loadEmps();
  };

  // ---- invoice-package wording per contract (stored with the package files) ----
  const [pkgSel, setPkgSel] = useState("");
  const [pkgInfo, setPkgInfo] = useState<PkgInfo>({});
  const [pkgLoading, setPkgLoading] = useState(false);
  const [pkgSaving, setPkgSaving] = useState(false);
  useEffect(() => {
    if (!pkgSel && contracts[0]) setPkgSel(contracts[0].id);
  }, [contracts, pkgSel]);
  useEffect(() => {
    if (!pkgSel) return;
    let stale = false;
    setPkgLoading(true);
    loadPkgInfo(pkgSel).then((info) => { if (!stale) { setPkgInfo(info); setPkgLoading(false); } });
    return () => { stale = true; };
  }, [pkgSel]);
  const savePkgDetails = async () => {
    if (!pkgSel) return;
    setPkgSaving(true);
    const clean: PkgInfo = {};
    if (pkgInfo.development?.trim()) clean.development = pkgInfo.development.trim();
    if (pkgInfo.amount?.trim()) clean.amount = pkgInfo.amount.trim();
    if (pkgInfo.eoProject?.trim()) clean.eoProject = pkgInfo.eoProject.trim();
    const err = await savePkgInfo(pkgSel, clean);
    setPkgSaving(false);
    flash(err || "Package details saved — every new package for this contract uses them");
  };

  // ---------- line items (the partner price list, and their own) ----------
  // Everything is held as typed text, so "1,395.00" survives being typed one
  // character at a time and a cleared box means "leave the sheet price alone".
  const [store, setStore] = useState<PriceStore>(EMPTY_STORE);
  const [priceText, setPriceText] = useState<Record<string, string>>({});
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceLoaded, setPriceLoaded] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [priceLoadErr, setPriceLoadErr] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const readList = () => {
    setPriceLoadErr(false);
    loadPrices().then(({ store: st, ok }) => {
      // the saved list is the base; anything already typed sits on top of it,
      // so a slow read can never throw away what they were doing — or, worse,
      // let the next save write an empty list over everything
      setStore((mine) => ({
        overrides: { ...st.overrides, ...mine.overrides },
        custom: [...st.custom.filter((c) => !mine.custom.some((m) => m.key === c.key)), ...mine.custom],
      }));
      setPriceLoaded(ok);
      setPriceLoadErr(!ok);
    });
  };
  useEffect(readList, []);
  const ovOf = (key: string): PriceOverride => store.overrides[key] || {};
  const setOv = (key: string, patch: PriceOverride) => {
    setPriceTouched(true);
    setStore((prev) => ({ ...prev, overrides: { ...prev.overrides, [key]: { ...prev.overrides[key], ...patch } } }));
  };
  // money boxes keep exactly what was typed until it's saved
  const moneyBox = (id: string, saved: number | undefined, fallback: number | undefined) => ({
    value: priceText[id] ?? (saved === undefined ? "" : String(saved)),
    placeholder: fallback === undefined ? "0" : String(fallback),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setPriceTouched(true);
      setPriceText((prev) => ({ ...prev, [id]: e.target.value.replace(/[^\d.,]/g, "") }));
    },
  });
  const typedNum = (id: string, current: number | undefined): number | undefined => {
    const t = priceText[id];
    if (t === undefined) return current;
    if (!t.trim()) return undefined;              // cleared = keep the sheet price
    const v = Number(t.replace(/,/g, ""));
    return Number.isFinite(v) ? v : current;
  };
  const setCustom = (key: string, patch: Partial<CustomItem>) => {
    setPriceTouched(true);
    setStore((prev) => ({ ...prev, custom: prev.custom.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  };
  const addCustom = () => {
    setPriceTouched(true);
    setStore((prev) => ({ ...prev, custom: [...prev.custom, blankCustom(prev.custom)] }));
  };
  const removeCustom = (key: string) => {
    setPriceTouched(true);
    setStore((prev) => ({ ...prev, custom: prev.custom.filter((c) => c.key !== key) }));
    setPriceText((prev) => { const next = { ...prev }; delete next[`${key}:price`]; return next; });
  };
  const savePriceList = async () => {
    if (!priceLoaded) { flash("Still reading the saved line items — try again in a second"); return; }
    setPriceSaving(true);
    // only what actually differs from the sheet gets stored
    const overrides: Record<string, PriceOverride> = {};
    for (const base of PRICE_BOOK) {
      const o = ovOf(base.key);
      const d: PriceOverride = {};
      const price = typedNum(`${base.key}:price`, o.price);
      const price2 = typedNum(`${base.key}:price2`, o.price2);
      if (price !== undefined && price !== base.price) d.price = price;
      if (base.price2 !== undefined && price2 !== undefined && price2 !== base.price2) d.price2 = price2;
      if (o.description?.trim() && o.description.trim() !== base.description) d.description = o.description.trim();
      if (o.unit?.trim() && o.unit.trim() !== base.unit) d.unit = o.unit.trim();
      if (o.extra?.trim()) d.extra = o.extra.trim();
      if (o.off) d.off = true;
      if (Object.keys(d).length > 0) overrides[base.key] = d;
    }
    const custom = store.custom
      .map((c) => ({ ...c, description: c.description.trim(), words: c.words.trim(), price: typedNum(`${c.key}:price`, c.price) ?? c.price ?? 0 }))
      .filter((c) => c.description.trim() && c.words.trim());
    const next: PriceStore = { overrides, custom };
    const err = await savePrices(next);
    setPriceSaving(false);
    if (err) { flash(err); return; }
    setStore(next); setPriceText({}); setPriceTouched(false);
    const live = bookFrom(next).length;
    flash(`Saved — ${live} line item${live === 1 ? "" : "s"} the PO reader will use from now on`);
  };

  const renameContract = async (c: Contract, name: string) => {
    const clean = name.trim() || c.number; // blank = back to the number
    // .select confirms a row actually changed — a role-blocked update returns
    // success with zero rows, which must not flash "Saved"
    const { data, error } = await sb().from("contracts").update({ name: clean }).eq("id", c.id).select("id");
    if (error || !data || data.length === 0) { flash(error ? error.message : "Didn't save — check your account's role"); return; }
    flash("Contract name saved");
    setContracts((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: clean } : x)));
  };

  const save = async (k: keyof Org, v: string) => {
    if (!org) return;
    const { data, error } = await sb().from("org").update({ [k]: v }).eq("id", 1).select("id");
    flash(error ? error.message : data && data.length > 0 ? "Saved" : "Didn't save — check your account's role");
  };
  const setRole = async (id: string, role: Role) => {
    const { error } = await sb().from("profiles").update({ role }).eq("id", id);
    flash(error ? error.message : "Role updated");
    loadUsers();
  };

  // sending someone a reset link — the only way to change another person's
  // password without a Supabase visit
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const sendReset = async () => {
    const email = resetEmail.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { flash("Type the person's email address first"); return; }
    setResetBusy(true);
    const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset` });
    setResetBusy(false);
    if (error) { flash(error.message); return; }
    setResetEmail("");
    flash(`Reset link sent to ${email} — they open it and pick a new password`);
  };

  const [addOpen, setAddOpen] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "office" as Role });
  const [adding, setAdding] = useState(false);
  const addUser = async () => {
    if (!newUser.email || newUser.password.length < 6) { flash("Enter an email and a password of at least 6 characters"); return; }
    setAdding(true);
    // separate throwaway client so creating the account never touches YOUR login
    const temp = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await temp.auth.signUp({ email: newUser.email.trim(), password: newUser.password });
    if (error) { setAdding(false); flash(error.message); return; }
    // Supabase hides duplicate emails behind a fake user with no identities
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setAdding(false); flash("That email already has an account — change their role in the list below instead."); return;
    }
    const newId = data.user?.id;
    let roleWarn = "";
    if (newId) {
      // the profile row is created automatically; set the display name and role
      const patch: { name?: string; role?: Role } = {};
      if (newUser.name.trim()) patch.name = newUser.name.trim();
      patch.role = newUser.role;
      // only an admin account can set roles — confirm the update really landed
      const { data: upd, error: pe } = await sb().from("profiles").update(patch).eq("id", newId).select("id");
      if (pe || !upd || upd.length === 0) roleWarn = " ⚠ The role didn't apply — an admin needs to set it in the list below.";
    }
    setAdding(false); setAddOpen(false);
    setNewUser({ name: "", email: "", password: "", role: "office" });
    flash(`Account created — they sign in with that email and password${roleWarn}${data.session ? "" : " (if they can't log in yet, they may need to click the confirmation email, or turn off “Confirm email” in Supabase → Authentication → Providers)"}`);
    loadUsers();
  };

  // ---------- system check: is every upgrade in place? ----------
  // ---------- full backup: the whole business in one workbook ----------
  const [backingUp, setBackingUp] = useState(false);
  const allOf = async (table: string, optional = false): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let from = 0;
    for (;;) {
      // ordered — unordered pages can overlap; and an error must fail the
      // backup loudly instead of downloading a silently short file
      const { data, error } = await sb().from(table).select("*").order("id").range(from, from + 999);
      if (error) {
        if (optional && /relation|does not exist|schema cache/i.test(error.message)) return out;
        throw new Error(`${table}: ${error.message}`);
      }
      if (!data || data.length === 0) break;
      out.push(...(data as Record<string, unknown>[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  };
  const downloadBackup = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine \u2014 check your signal and try again"); return; }
    setBackingUp(true);
    try {
      const [cs, rels, emps, wks, ents, pact, props, relItems, priceBook, cItems, sched] = await Promise.all([
        allOf("contracts"), allOf("releases"), allOf("employees"),
        allOf("timesheet_weeks"), allOf("timesheet_entries"), allOf("pact_jobs"), allOf("proposals"),
        allOf("release_items", true), allOf("price_items", true), allOf("contract_items", true), allOf("schedule_days", true),
      ]);
      const cNum = new Map(cs.map((c) => [c.id, `${c.number}`]));
      const eName = new Map(emps.map((e) => [e.id, `${e.name}`]));
      const wEnd = new Map(wks.map((w) => [w.id, `${w.week_ending}`]));
      const wb = XLSX.utils.book_new();
      const add = (name: string, rows: Record<string, unknown>[]) =>
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "nothing here yet" }]), name);
      add("Contracts", cs.map((c) => ({ Contract: c.number, Name: c.name })));
      add("Releases", rels.map((r) => ({
        Contract: cNum.get(r.contract_id as string) || "", Release: r.rel_number, Development: r.location,
        Address: r.buildings || r.address || "", Ticket: r.ticket, Amount: Number(r.amount) || 0,
        Received: r.received ? "yes" : "", "Paid date": r.paid_date || "",
        Invoiced: r.invoice_sent || "", "Payroll done": r.payroll_done ? "yes" : "", "Labor hrs": Number(r.labor_hours) || 0,
        Start: r.start_date || "", Finish: r.finish_date || "", Canceled: r.canceled ? "yes" : "",
      })));
      add("Payroll", ents.map((en) => {
        const hours = ((en.hours as number[]) || []).map((h) => Number(h) || 0);
        return {
          "Week ending": wEnd.get(en.week_id as string) || "", Worker: eName.get(en.employee_id as string) || "?",
          Classification: (en.trade as string) || "", Job: en.job_label || "",
          Sat: hours[0] || 0, Sun: hours[1] || 0, Mon: hours[2] || 0, Tue: hours[3] || 0,
          Wed: hours[4] || 0, Thu: hours[5] || 0, Fri: hours[6] || 0,
          Total: hours.reduce((s, h) => s + h, 0),
        };
      }).sort((a, b) => `${a["Week ending"]}${a.Worker}`.localeCompare(`${b["Week ending"]}${b.Worker}`)));
      add("Crew", emps.filter((e) => e.active !== false).map((e) => ({ Name: e.name, Classification: e.trade || "" })));
      add("PACT", pact.map((j) => ({
        Partner: j.partner, PO: j.po_number || j.job_number || "", Address: j.address || "",
        Description: j.description || "", Amount: Number(j.amount) || 0, Approved: j.approved ? "yes" : "",
        "Work done": j.work_done ? "yes" : "", Invoiced: j.invoice_sent || "", Paid: j.received ? "yes" : "",
        Start: j.start_date || "", Finish: j.finish_date || "", Canceled: j.canceled ? "yes" : "",
      })));
      add("Walk sheets", props.map((p) => ({
        Number: p.number, Name: p.job || "", Contract: cNum.get(p.contract_id as string) || "",
        Development: p.development || "", "Release #": p.release_number || "", Status: p.status, Total: Number(p.total) || 0,
      })));
      // who's been paid which week (the PAID stamps)
      add("Paid marks", wks.flatMap((w) => Object.entries((w.paid_map as Record<string, string>) || {}).map(([eid, on]) => ({
        "Week ending": `${w.week_ending}`, Worker: eName.get(eid) || "?", "Paid on": on,
      }))).sort((a, b) => `${a["Week ending"]}${a.Worker}`.localeCompare(`${b["Week ending"]}${b.Worker}`)));
      const relInfo = new Map(rels.map((r) => [r.id, r]));
      add("Release items", relItems.map((it) => {
        const r = relInfo.get(it.release_id as string);
        return {
          Contract: r ? cNum.get(r.contract_id as string) || "" : "", Release: r ? `${r.rel_number}` : "?",
          Line: it.line, Code: it.code, Description: it.description, UOM: it.uom,
          Qty: Number(it.qty) || 0, "Unit price": Number(it.unit_price) || 0, Amount: Number(it.amount) || 0,
        };
      }));
      add("Price book", priceBook.map((it) => ({
        Code: it.code, Category: it.category || "", Description: it.description, UOM: it.unit || it.uom || "", "Unit price": Number(it.unit_price) || 0,
      })));
      add("Contract books", cItems.map((it) => ({
        Contract: cNum.get(it.contract_id as string) || "", Line: it.line, Code: it.code, Category: it.category || "",
        Description: it.description, UOM: it.uom, "Unit price": Number(it.unit_price) || 0,
      })));
      add("Schedule", sched.map((s) => {
        const r = relInfo.get(s.release_id as string);
        return {
          Day: `${s.day}`, Release: r ? `#${r.rel_number} — ${r.location}` : "", Worker: eName.get(s.employee_id as string) || "?",
          Description: s.description || "", Address: s.address || "", Texted: s.texted ? "yes" : "",
        };
      }));
      const fname = askFileName(`earthlink_backup_${new Date().toISOString().slice(0, 10)}.xlsx`);
      if (fname) XLSX.writeFile(wb, fname);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Backup failed");
    }
    setBackingUp(false);
  };

  type CheckResult = { label: string; fix: string; ok: boolean };
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  // storage meter: how full the docs bucket is (via the storage_usage() function)
  const [storage, setStorage] = useState<{ bytes: number; files: number } | "missing" | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const checkStorage = async () => {
    setStorageBusy(true);
    const { data, error } = await sb().rpc("storage_usage");
    setStorageBusy(false);
    if (error) { setStorage(/function|schema cache|not.*found/i.test(error.message) ? "missing" : null); if (storage !== "missing" && !/function|schema cache|not.*found/i.test(error.message)) flash(error.message); return; }
    const d = data as { bytes?: number; files?: number } | null;
    setStorage({ bytes: Number(d?.bytes) || 0, files: Number(d?.files) || 0 });
  };
  const [checking, setChecking] = useState(false);
  const runSystemCheck = async () => {
    setChecking(true); setChecks(null);
    const probes: { label: string; fix: string; probe: () => Promise<boolean> }[] = [
      { label: "Release line items", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().from("release_items").select("id").limit(1)).error },
      { label: "Release aging & attachments", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().from("releases").select("invoice_sent,paid_date,attachments,address").limit(1)).error },
      { label: "Document & photo storage", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().storage.from("docs").list("", { limit: 1 })).error },
      { label: "Contract price books", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("contract_items").select("id").limit(1)).error },
      { label: "Walk sheet fields & autosave", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("proposals").select("qty_map,nycha_staff,start_date,release_number,total").limit(1)).error },
      { label: "Price book line numbers", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("price_items").select("line").limit(1)).error },
      { label: "Payroll paid marks", fix: "upgrade_payroll_paid.sql", probe: async () => !(await sb().from("timesheet_weeks").select("paid_map").limit(1)).error },
      { label: "Payroll entry classifications", fix: "upgrade_payroll_class.sql", probe: async () => !(await sb().from("timesheet_entries").select("trade").limit(1)).error },
      { label: "Worker phone numbers (tap-to-text)", fix: "upgrade_worker_phone.sql", probe: async () => !(await sb().from("employees").select("phone").limit(1)).error },
      { label: "Day schedule (Schedule tab)", fix: "upgrade_day_schedule.sql", probe: async () => !(await sb().from("schedule_days").select("id,address").limit(1)).error },
      { label: "Company texting number (Twilio)", fix: "add TWILIO keys in Vercel → Settings → Environment Variables (texts fall back to your phone until then)", probe: async () => { try { const r = await fetch("/api/text"); return !!((await r.json()) as { configured?: boolean }).configured; } catch { return false; } } },
      { label: "PACT schedule dates", fix: "upgrade_schedule.sql", probe: async () => !(await sb().from("pact_jobs").select("start_date,finish_date").limit(1)).error },
      { label: "PACT jobs & invoicing", fix: "upgrade_pact.sql", probe: async () => !(await sb().from("pact_jobs").select("id,po_number,items,tax_pct,invoice_number").limit(1)).error },
    ];
    const results: CheckResult[] = [];
    for (const p of probes) {
      let ok = false;
      try { ok = await p.probe(); } catch { ok = false; }
      results.push({ label: p.label, fix: p.fix, ok });
    }
    setChecks(results); setChecking(false);
  };

  if (!org) return <div className="text-sm text-inksoft">Loading…</div>;
  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Settings</div>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Company letterhead</div>
      <div className="card grid gap-3 p-4 md:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
            <input className="field" value={org[k] || ""} onChange={(e) => setOrg({ ...org, [k]: e.target.value })} onBlur={(e) => save(k, e.target.value)} />
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-inksoft">Every proposal, SOS, and statement carries this letterhead. Fields save when you tap out of them.</div>

      {contracts.length > 0 && (
        <>
          <div className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Contract names</div>
          <div className="card divide-y divide-rulesoft">
            {contracts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-3">
                <span className="w-28 shrink-0 font-mono text-[13px] font-semibold">{c.number}</span>
                <input className="field" placeholder={`e.g. Queensbridge IDIQ`} defaultValue={c.name && c.name !== c.number ? c.name : ""}
                  onBlur={(e) => renameContract(c, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-inksoft">Give contracts a name you recognize — dropdowns everywhere show the name instead of just the number. Leave blank to show the number.</div>
        </>
      )}

      <div className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Crew phone numbers</div>
      <div className="card p-3.5">
        <div className="mb-2 text-xs text-inksoft">The numbers the Schedule tab texts. Numbers save when you tap out of the field.</div>
        {me?.role !== "accountant" && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <input className="field" placeholder="Name" value={crewDraft.name} onChange={(e) => setCrewDraft({ ...crewDraft, name: e.target.value })} />
            <input className="field" placeholder="Usual classification (laborer…)" value={crewDraft.trade} onChange={(e) => setCrewDraft({ ...crewDraft, trade: e.target.value })} />
            <input className="field" placeholder="Phone (for texts)" inputMode="tel" value={crewDraft.phone} onChange={(e) => setCrewDraft({ ...crewDraft, phone: e.target.value })} />
            <button className="btn btn-primary" onClick={addWorker}>Add</button>
          </div>
        )}
        <div className="mt-2 divide-y divide-rulesoft">
          {emps.filter((e) => e.active !== false).map((e) => {
            const buf = phoneBuf[e.id] ?? prettyPhone(e.phone || "");
            return (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0"><b>{e.name}</b>{e.trade ? <span className="ml-2 text-xs text-inksoft">{e.trade}</span> : null}</span>
                <span className="flex items-center gap-2">
                  <input className="field w-44 px-2 py-1.5 text-[13px]" placeholder="Phone number" inputMode="tel" readOnly={me?.role === "accountant"}
                    value={buf} onChange={(ev) => setPhoneBuf((p) => ({ ...p, [e.id]: ev.target.value }))}
                    onBlur={() => { if (cleanPhone(buf) !== cleanPhone(e.phone || "")) savePhone(e.id, buf); }} />
                  {me?.role !== "accountant" && <button className="text-xs text-alert" title="Remove from the crew list" onClick={async () => { await sb().from("employees").update({ active: false }).eq("id", e.id); loadEmps(); }}>✕</button>}
                </span>
              </div>
            );
          })}
          {emps.filter((e) => e.active !== false).length === 0 && <div className="py-3 text-sm text-inksoft">No crew yet — add workers above.</div>}
        </div>
      </div>

      {contracts.length > 0 && me?.role !== "accountant" && (
        <>
          <div className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Invoice package details</div>
          <div className="card p-4">
            <div className="mb-3 text-xs text-inksoft">
              What gets written onto the package documents (REP, Section 3 hiring summary, Equal Opportunity report)
              for each contract. The contract number always fills in by itself — these are the parts that differ per
              contract. Blank fields keep the standard wording. Saved changes apply to every package made after that.
            </div>
            <div className="mb-3">
              <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract</div>
              <select className="field max-w-sm" value={pkgSel} onChange={(e) => setPkgSel(e.target.value)}>
                {contracts.map((c) => <option key={c.id} value={c.id}>{c.name && c.name !== c.number ? `${c.number} — ${c.name}` : c.number}</option>)}
              </select>
            </div>
            {pkgLoading ? (
              <div className="text-sm text-inksoft">Loading this contract&apos;s wording…</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Development / work description (REP + hiring summary)</div>
                  <textarea className="field min-h-[56px]" placeholder={PKG_DEFAULTS.development}
                    value={pkgInfo.development || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, development: e.target.value })} />
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract amount (REP + hiring summary)</div>
                  <input className="field" placeholder={PKG_DEFAULTS.amount}
                    value={pkgInfo.amount || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, amount: e.target.value })} />
                </div>
                <div className="md:col-span-2">
                  <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Project name &amp; no. (Equal Opportunity report header)</div>
                  <textarea className="field min-h-[56px]" placeholder={PKG_DEFAULTS.eoProject}
                    value={pkgInfo.eoProject || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, eoProject: e.target.value })} />
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={savePkgDetails} disabled={pkgSaving || pkgLoading}>{pkgSaving ? "Saving…" : "Save package details"}</button>
              <span className="text-xs text-inksoft">The affidavit and full replacement PDFs upload on the Invoice Package tab.</span>
            </div>
          </div>
        </>
      )}

      {me && (me.role === "admin" || me.role === "office") && (
        <>
          <div className="mb-2 mt-6 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Line items &amp; prices</div>
            <button className="text-[11px] uppercase tracking-widest text-inksoft underline" onClick={() => setShowWords(!showWords)}>
              {showWords ? "hide PO wording" : "edit PO wording"}
            </button>
          </div>
          <div className="card p-4">
            <div className="mb-3 text-xs text-inksoft">
              These are the lines a PO gets turned into — the prices quoted to Fairstead and Boulevard, plus anything you
              add of your own. Upload a PO and whatever it asks for lands on the job and on the proposal, priced from
              here. Plaster brings its primer and paint along with it. Painting is priced per apartment, one coat or two.
              {showWords ? " The wording box is what a PO has to say to pick that line — plain words, separated by commas." : ""}
            </div>
            {[...PRICE_GROUPS, CUSTOM_GROUP].map((g) => {
              const rows = g === CUSTOM_GROUP ? [] : PRICE_BOOK.filter((p) => p.group === g);
              if (g !== CUSTOM_GROUP && rows.length === 0) return null;
              return (
                <div key={g} className="mb-3">
                  <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{g}</div>
                  <div className="card divide-y divide-rulesoft">
                    {rows.map((p) => {
                      const o = ovOf(p.key);
                      const off = !!o.off;
                      return (
                        <div key={p.key} className={`p-2.5 ${off ? "opacity-45" : ""}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <input className="min-w-[170px] flex-1 field px-2 py-1.5 text-[13px]" value={o.description ?? p.description}
                              placeholder={p.description} onChange={(e) => setOv(p.key, { description: e.target.value })} />
                            <select className="field w-[74px] px-1 py-1.5 text-center text-[11px]" title="How it's measured"
                              value={o.unit ?? p.unit} onChange={(e) => setOv(p.key, { unit: e.target.value })}>
                              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                            <label className="flex items-center gap-1">
                              {p.price2 !== undefined && <span className="text-[11px] text-inksoft">1 coat</span>}
                              <span className="text-sm">$</span>
                              <input className="field w-24 px-2 py-1.5 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${p.key}:price`, o.price, p.price)} />
                            </label>
                            {p.price2 !== undefined && (
                              <label className="flex items-center gap-1">
                                <span className="text-[11px] text-inksoft">2 coat</span>
                                <span className="text-sm">$</span>
                                <input className="field w-24 px-2 py-1.5 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${p.key}:price2`, o.price2, p.price2)} />
                              </label>
                            )}
                            <button className={`text-xs ${off ? "text-work" : "text-inksoft"}`} title={off ? "Use this line again" : "Stop using this line"}
                              onClick={() => setOv(p.key, { off: !off })}>{off ? "off" : "✕"}</button>
                          </div>
                          {showWords && (
                            <input className="field mt-1.5 px-2 py-1.5 text-[12px]" value={o.extra || ""}
                              placeholder={`extra wording a PO might use for this — e.g. "textured ceiling, stipple"`}
                              onChange={(e) => setOv(p.key, { extra: e.target.value })} />
                          )}
                        </div>
                      );
                    })}
                    {g === CUSTOM_GROUP && store.custom.map((c) => (
                      <div key={c.key} className="p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <input className="min-w-[170px] flex-1 field px-2 py-1.5 text-[13px]" value={c.description}
                            placeholder="What the line says on the invoice" onChange={(e) => setCustom(c.key, { description: e.target.value })} />
                          <select className="field w-[74px] px-1 py-1.5 text-center text-[11px]" title="How it's measured"
                            value={c.unit} onChange={(e) => setCustom(c.key, { unit: e.target.value })}>
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <label className="flex items-center gap-1">
                            <span className="text-sm">$</span>
                            <input className="field w-24 px-2 py-1.5 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${c.key}:price`, c.price || undefined, 0)} />
                          </label>
                          <button className="text-xs text-alert" title="Remove this line item" onClick={() => removeCustom(c.key)}>✕</button>
                        </div>
                        <input className={`field mt-1.5 px-2 py-1.5 text-[12px] ${c.description.trim() && !c.words.trim() ? "border-work" : ""}`} value={c.words}
                          placeholder={`what a PO says for this — plain words, commas between: "move out, moveout clean"`}
                          onChange={(e) => setCustom(c.key, { words: e.target.value })} />
                        {c.description.trim() && !c.words.trim() && (
                          <div className="mt-1 text-[11px] text-work">Needs wording, or a PO can never pick this line.</div>
                        )}
                      </div>
                    ))}
                    {g === CUSTOM_GROUP && store.custom.length === 0 && (
                      <div className="p-2.5 text-xs text-inksoft">Nothing of your own yet — add a line for work the partners&apos; sheet doesn&apos;t cover.</div>
                    )}
                  </div>
                  {g === CUSTOM_GROUP && (
                    <button className="btn btn-ghost mt-2 px-3 py-1.5 text-[13px]" onClick={addCustom}>+ Add line item</button>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={savePriceList} disabled={priceSaving || !priceLoaded}>{priceSaving ? "Saving…" : priceLoaded ? "Save line items" : "Reading saved list…"}</button>
              {priceLoadErr && (
                <button className="btn" onClick={readList}>Couldn&apos;t read the saved list — try again</button>
              )}
              <button className="btn btn-ghost" onClick={() => { setStore(EMPTY_STORE); setPriceText({}); setPriceTouched(true); flash("Back to the sheet as it came — save to keep it"); }}>Reset to the sheet</button>
            </div>
          </div>
        </>
      )}

      {me?.role === "admin" && (
        <>
          <div className="mb-2 mt-6 flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Users &amp; roles</div>
            <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setAddOpen(!addOpen)}>+ Add user</button>
          </div>
          {addOpen && (
            <div className="card mb-3 border-work p-3.5">
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Name</div>
                  <input className="field" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Email</div>
                  <input className="field" inputMode="email" autoCapitalize="none" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Password</div>
                  <input className="field" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Role</div>
                  <select className="field" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
                    {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                  </select></div>
              </div>
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary" onClick={addUser} disabled={adding}>{adding ? "Creating…" : "Create account"}</button>
                <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              </div>
              <div className="mt-2 text-xs text-inksoft">Give them this email + password to sign in. You can change their role any time below.</div>
            </div>
          )}
          <div className="card divide-y divide-rulesoft">
            {people.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 p-3">
                <div className="text-sm font-medium">{p.name || p.id.slice(0, 8)}{p.id === me.id && <span className="ml-2 text-[11px] text-inksoft">(you)</span>}</div>
                <select className="field max-w-[220px]" value={p.role} onChange={(e) => setRole(p.id, e.target.value as Role)}>
                  {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                  {!ROLE_OPTIONS.some(([r]) => r === p.role) && <option value={p.role}>{p.role} (legacy)</option>}
                </select>
              </div>
            ))}
          </div>
          <div className="card mt-2 p-3">
            <div className="text-[11px] uppercase tracking-widest text-inksoft">Change someone&apos;s password</div>
            <div className="mt-1 text-xs text-inksoft">Sends them a link to pick a new one. Works for an account that already exists — including your own.</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input className="field max-w-xs flex-1" type="email" inputMode="email" placeholder="their email address"
                value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} />
              <button className="btn" onClick={sendReset} disabled={resetBusy}>{resetBusy ? "Sending…" : "Send reset link"}</button>
            </div>
          </div>
          <div className="mt-2 text-xs text-inksoft">
            New people: use + Add user above (email, password, role). They can sign in straight away.
          </div>
        </>
      )}

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">File storage</div>
        <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={checkStorage} disabled={storageBusy}>{storageBusy ? "Measuring…" : "Check storage"}</button>
      </div>
      <div className="card p-3.5 text-sm">
        {storage === null && !storageBusy && (
          <div className="text-inksoft">How full is the photo &amp; document storage — tap Check storage. The free Supabase plan includes 1 GB; upgrade only when this gets near the top.</div>
        )}
        {storage === "missing" && (
          <div className="text-inksoft">Run <span className="font-mono">supabase/upgrade_storage_meter.sql</span> (it&apos;s in RUN_ME.sql too) to turn on the storage meter.</div>
        )}
        {storage !== null && storage !== "missing" && (() => {
          const gb = 1024 * 1024 * 1024;
          const pct = Math.min(100, Math.round((storage.bytes / gb) * 100));
          const mb = Math.round(storage.bytes / 1024 / 1024);
          const tone = pct < 60 ? "text-ok" : pct < 85 ? "text-work" : "text-alert";
          return (
            <>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="font-mono font-semibold">{mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(2)} GB`} of 1 GB</span>
                <span className={`font-mono text-xs font-semibold ${tone}`}>{pct}% · {storage.files.toLocaleString()} files</span>
              </div>
              <div className="h-2 w-full rounded-sm bg-rulesoft">
                <div className={`h-2 rounded-sm ${pct < 60 ? "bg-ok" : pct < 85 ? "bg-work" : "bg-alert"}`} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-inksoft">
                {pct < 60 && "Plenty of room — no need to upgrade Supabase."}
                {pct >= 60 && pct < 85 && "Getting fuller — fine for now, but plan on Supabase Pro ($25/mo, 100 GB) in the coming months."}
                {pct >= 85 && "Nearly full — upgrade to Supabase Pro ($25/mo, 100 GB) soon, or new photo uploads will start failing."}
                {" "}(If you&apos;ve already upgraded, the real limit is 100 GB and this bar reads against 1 GB.)
              </div>
            </>
          );
        })()}
      </div>

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Backup</div>
        <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={downloadBackup} disabled={backingUp}>{backingUp ? "Building…" : "Download full backup (xlsx)"}</button>
      </div>
      <div className="card p-3.5 text-sm text-inksoft">
        One Excel workbook with everything — contracts, releases (with payments), every payroll week, the crew, PACT jobs, and walk sheets. Worth downloading every Friday and keeping somewhere safe.
      </div>

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">System check</div>
        <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={runSystemCheck} disabled={checking}>{checking ? "Checking…" : "Run system check"}</button>
      </div>
      <div className="card p-3.5">
        {checks === null && !checking && <div className="text-sm text-inksoft">Verifies the database has every upgrade. If something&apos;s missing it names the exact SQL file to paste into Supabase — or just run <span className="font-mono">supabase/RUN_ME.sql</span> to apply everything at once.</div>}
        {checking && <div className="text-sm text-inksoft">Checking…</div>}
        {checks !== null && (
          <>
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-sm first:border-t-0">
                <span>{c.ok ? "✅" : "❌"} {c.label}</span>
                {!c.ok && <span className="font-mono text-xs text-alert">run {c.fix}</span>}
              </div>
            ))}
            <div className="mt-2 border-t border-rulesoft pt-2 text-sm font-semibold">
              {checks.every((c) => c.ok)
                ? <span className="text-ok">Everything is set up — all upgrades are in place. ✓</span>
                : <span className="text-alert">{checks.filter((c) => !c.ok).length} item(s) missing — easiest fix: paste supabase/RUN_ME.sql into the Supabase SQL Editor and Run.</span>}
            </div>
            <div className="mt-1 text-xs text-inksoft">Live updates can&apos;t be auto-verified from here — if screens don&apos;t refresh on their own after everything above is green, run upgrade_realtime.sql (it&apos;s included in RUN_ME.sql).</div>
          </>
        )}
      </div>

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { RowActions } from "@/components/ActionMenu";
import ContractPicker from "@/components/ContractPicker";
import Disclosure from "@/components/Disclosure";
import PageHeader from "@/components/PageHeader";
import SaveBar from "@/components/SaveBar";
import Toast, { useFlash } from "@/components/Toast";
// the export engine is heavy: it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { useLive } from "@/lib/useLive";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import { scrollTo } from "@/lib/motion";
import type { Org } from "@/lib/docs";
import type { Contract, Profile, Role } from "@/lib/types";
import { ROLE_LABEL, ROLE_OPTIONS } from "@/lib/roles";
import { PKG_DEFAULTS, type PkgInfo, loadPkgInfo, savePkgInfo } from "@/lib/packageDocs";
import { PRICE_BOOK, PRICE_GROUPS, CUSTOM_GROUP, EMPTY_STORE, DEFAULT_ATTN, blankCustom, bookFrom, keywordsRe, loadPrices, savePrices,
  type PriceOverride, type PriceStore, type CustomItem } from "@/lib/priceBook";
import { cleanPhone, prettyPhone } from "@/lib/notify";
import { langOf, LANG_LABEL, type Lang } from "@/lib/crewText";
import LangToggle from "@/components/LangToggle";

// the two roles people are offered come from lib/roles.ts: Admin 1 sees
// everything; Admin 2 works PACT without ever seeing a price, an amount, an
// invoice or a proposal (internally these are the existing admin/office roles)
// how a line is measured: counted, by the square foot, by the room, or by the hour
const UNITS = ["EACH", "SF", "ROOM", "HOUR"];

// the letterhead boxes: what each is called, and a hint where the name alone doesn't say
const FIELDS: [keyof Org, string, string?][] = [
  ["company", "Company name"], ["address1", "Street address"], ["address2", "City, State ZIP"],
  ["phone", "Phone"], ["email", "Email"], ["license", "License #", "Shows on documents"], ["terms", "Payment terms", "Net 30"],
];

// Enter in a box that saves when you tap out of it: tap out for them
const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };

// Supabase's own words never reach the screen: say what happened and what to do
const authWhy = (m: string) =>
  /already|registered|exists/i.test(m) ? "That email already has an account. Change their role in the list below instead."
    : /password/i.test(m) ? "The password needs at least 6 characters."
      : /rate|seconds|too many/i.test(m) ? "Too many tries just now. Wait a minute and try again."
        : /email|address/i.test(m) ? "That doesn't look like an email address."
          : "Check your signal and try again.";

// in a fix line, file names, variable names and web addresses read in mono; the rest is plain words
const MONO_RE = /(https?:\/\/\S+|\b[\w./-]+\.(?:sql|json)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\/api\/[\w-]+)/g;
const mono = (text: string) => text.split(MONO_RE).map((part, i) => (i % 2 === 1 ? <span key={i} className="font-mono text-[12px]">{part}</span> : part));

// three shimmering rows hold a list's place while it loads
const SkeletonRows = () => (
  <>
    {[0, 1, 2].map((i) => (
      <div key={i} className="p-3" aria-hidden>
        <div className="flex gap-2"><div className="skeleton h-4 w-32" /><div className="skeleton h-4 w-16" /></div>
        <div className="skeleton mt-2 h-4 w-44" />
      </div>
    ))}
  </>
);

export default function Settings() {
  const [org, setOrg] = useState<Org | null>(null);
  const [me, setMe] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Profile[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const { msg, flash } = useFlash();

  // the email column arrives with supabase/upgrade_user_email.sql; until that is
  // run the page still works, it just cannot show anyone's address
  const [noEmailCol, setNoEmailCol] = useState(false);
  const loadUsers = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;
    const { data: p } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
    setMe(p as Profile);
    if ((p as Profile)?.role === "admin") {
      const withEmail = await sb().from("profiles").select("id,name,role,email").order("name");
      if (withEmail.error) {
        setNoEmailCol(true);
        const { data: all } = await sb().from("profiles").select("id,name,role").order("name");
        setPeople((all || []) as Profile[]);
      } else {
        setNoEmailCol(false);
        setPeople((withEmail.data || []) as Profile[]);
      }
      setPeopleLoaded(true);
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
  type Emp = { id: string; name: string; trade: string; active: boolean; phone?: string | null; lang?: string | null };
  const [emps, setEmps] = useState<Emp[]>([]);
  const [empsLoaded, setEmpsLoaded] = useState(false);
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [crewDraft, setCrewDraft] = useState({ name: "", trade: "", phone: "", lang: "en" as Lang });
  // /settings#crew (the Payroll page's "Crew list" link) opens the Crew section and scrolls to it
  const [crewOpen, setCrewOpen] = useState(false);
  const [goCrew, setGoCrew] = useState(false);
  useEffect(() => { if (window.location.hash === "#crew") { setCrewOpen(true); setGoCrew(true); } }, []);
  useEffect(() => { if (org && goCrew) { setGoCrew(false); scrollTo(document.getElementById("crew"), "start"); } }, [org, goCrew]);
  // each worker's language for the crew text (RUN_ME section 18); before it, read without
  const loadEmps = async () => {
    let r = await sb().from("employees").select("id,name,trade,active,phone,lang").order("name") as { data: unknown; error: { message: string } | null };
    if (r.error && /lang|column|schema cache/i.test(r.error.message)) r = await sb().from("employees").select("id,name,trade,active,phone").order("name");
    setEmps((r.data || []) as Emp[]);
    setEmpsLoaded(true);
  };
  const saveLang = async (empId: string, lang: Lang) => {
    setEmps((prev) => prev.map((e) => (e.id === empId ? { ...e, lang } : e)));
    const { error } = await sb().from("employees").update({ lang }).eq("id", empId);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql so each worker's language saves" : "Couldn't save the language. Check your signal and try again."); loadEmps(); return; }
    flash(`${emps.find((e) => e.id === empId)?.name.split(" ")[0] || "The worker"} gets texts in ${LANG_LABEL[lang]}`);
  };
  // English | Español, one tap
  const langPick = (value: Lang, onPick: (l: Lang) => void, disabled = false, name?: string) => <LangToggle value={value} onChange={onPick} disabled={disabled} full name={name} />;
  useEffect(() => { loadEmps(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["employees"], loadEmps, { skipWhileTyping: true });
  const savePhone = async (empId: string, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    const { error } = await sb().from("employees").update({ phone }).eq("id", empId);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql so phone numbers save" : "Couldn't save the phone number. Check your signal and try again."); return; }
    setEmps((prev) => prev.map((e) => (e.id === empId ? { ...e, phone } : e)));
    flash("Phone number saved");
  };
  const addWorker = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    if (!crewDraft.name) return;
    const row: Record<string, unknown> = { name: crewDraft.name, trade: crewDraft.trade, base_rate: 0 };
    if (crewDraft.phone.trim()) row.phone = cleanPhone(crewDraft.phone) || crewDraft.phone.trim();
    if (crewDraft.lang !== "en") row.lang = crewDraft.lang;
    let { error } = await sb().from("employees").insert(row);
    if (error && ("phone" in row || "lang" in row) && /column|schema cache/i.test(error.message)) {
      // only the column the database says it lacks is left out: a phone typed beside a language is kept
      const missing = /\blang\b/i.test(error.message) ? ["lang"] : /\bphone\b/i.test(error.message) ? ["phone"] : ["phone", "lang"];
      for (const k of missing) delete row[k];
      ({ error } = await sb().from("employees").insert(row));
      if (!error) flash(`Run supabase/RUN_ME.sql so ${missing.includes("phone") && missing.includes("lang") ? "phone numbers and languages save" : missing[0] === "lang" ? "each worker's language saves. The phone number was kept" : "phone numbers save. The language was kept"}`);
    }
    if (error) { flash(`Couldn't add ${crewDraft.name} to the crew. Check your signal and try again.`); return; }
    setCrewDraft({ name: "", trade: "", phone: "", lang: "en" }); loadEmps();
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
    flash(err ? "Couldn't save the package details. Check your signal and try again." : "Package details saved. Every new package for this contract uses them");
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
      // so a slow read can never throw away what they were doing, or, worse,
      // let the next save write an empty list over everything
      setStore((mine) => ({
        // field by field: a switch flicked before the read landed must not
        // erase the price that was saved for the same line
        overrides: Object.fromEntries(
          [...new Set([...Object.keys(st.overrides), ...Object.keys(mine.overrides)])]
            .map((k) => [k, { ...st.overrides[k], ...mine.overrides[k] }])
        ),
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
  useEffect(() => {
    if (!priceTouched) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [priceTouched]);

  const savePriceList = async () => {
    if (!priceLoaded) { flash("Still reading the saved line items. Try again in a second"); return; }
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
      // their own lines have no sheet price behind them, so an empty box is 0
      .map((c) => ({ ...c, description: c.description.trim(), words: c.words.trim(), price: priceText[`${c.key}:price`] !== undefined ? (typedNum(`${c.key}:price`, c.price) ?? 0) : (c.price ?? 0) }))
      .filter((c) => c.description.trim() && c.words.trim());
    // saved as typed, including deliberately blank, so proposals can be left
    // unaddressed rather than falling back to the built-in name
    const attn = store.attn
      ? { name: (store.attn.name ?? DEFAULT_ATTN.name).trim(), title: (store.attn.title ?? DEFAULT_ATTN.title).trim() }
      : undefined;
    const next: PriceStore = { overrides, custom, ...(attn ? { attn } : {}) };
    const err = await savePrices(next);
    setPriceSaving(false);
    // savePrices writes nothing at all when it can't finish, so "nothing was changed" is always true here
    if (err) { flash("Couldn't save the line items. Nothing was changed. Try again in a moment."); return; }
    setStore(next); setPriceText({}); setPriceTouched(false);
    const live = bookFrom(next).length;
    flash(`Saved. ${live} line item${live === 1 ? "" : "s"} the PO reader will use from now on`);
  };

  const renameContract = async (c: Contract, name: string) => {
    const clean = name.trim() || c.number; // blank = back to the number
    // .select confirms a row actually changed: a role-blocked update returns
    // success with zero rows, which must not flash "saved"
    const { data, error } = await sb().from("contracts").update({ name: clean }).eq("id", c.id).select("id");
    if (error || !data || data.length === 0) { flash(error ? "Couldn't save the contract name. Check your signal and try again." : "Didn't save. Check your account's role"); return; }
    flash("Contract name saved");
    setContracts((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: clean } : x)));
  };

  const save = async (k: keyof Org, v: string) => {
    if (!org) return;
    const { data, error } = await sb().from("org").update({ [k]: v }).eq("id", 1).select("id");
    flash(error ? "Couldn't save the letterhead. Check your signal and try again." : data && data.length > 0 ? "Letterhead saved" : "Didn't save. Check your account's role");
  };
  const setRole = async (id: string, role: Role) => {
    const { error } = await sb().from("profiles").update({ role }).eq("id", id);
    flash(error ? "Couldn't change the role. Check your signal and try again." : "Role saved");
    loadUsers();
  };
  // changing your own role can lock you out of parts of this page, so it asks first
  const changeRole = (p: Profile, role: Role) => {
    if (role === p.role) return;
    if (p.id === me?.id && !window.confirm("Change your own role? You will lose access to parts of Settings.")) return;
    setRole(p.id, role);
  };
  // renaming someone: typed into a box that keeps what you type, saved when you
  // tap away. An empty name is rejected rather than saved as a blank row
  const [nameBuf, setNameBuf] = useState<Record<string, string>>({});
  const saveName = async (p: Profile) => {
    const typed = (nameBuf[p.id] ?? "").trim();
    if (!typed || typed === (p.name || "")) {
      setNameBuf((b) => { const n = { ...b }; delete n[p.id]; return n; });
      return;
    }
    // the typed name stays in the box until the save is CONFIRMED: a failed
    // save must not silently revert to the old name and lose the typing
    const { data, error } = await sb().from("profiles").update({ name: typed }).eq("id", p.id).select("id");
    if (error) { flash("Couldn't save the name. The name you typed is still in the box."); return; }
    if (!data || data.length === 0) { flash("Didn't save. Only Admin 1 can rename people"); return; }
    setNameBuf((b) => { const n = { ...b }; delete n[p.id]; return n; });
    flash("Name saved");
    loadUsers();
  };

  // sending someone a reset link: the only way to change another person's
  // password without a Supabase visit
  const [resetBusy, setResetBusy] = useState(false);
  const sendResetTo = async (raw: string) => {
    const email = raw.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { flash("Type the person's email address first"); return; }
    setResetBusy(true);
    const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset` });
    setResetBusy(false);
    if (error) { flash(`Couldn't send the reset link. ${authWhy(error.message)}`); return; }
    flash(`Reset link sent to ${email}. They open it and pick a new password`);
  };

  const [addOpen, setAddOpen] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "office" as Role });
  const [adding, setAdding] = useState(false);
  const addUser = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    if (!newUser.email || newUser.password.length < 6) { flash("Enter an email and a password of at least 6 characters"); return; }
    const email = newUser.email.trim();
    setAdding(true);
    // separate throwaway client so creating the account never touches YOUR login
    const temp = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await temp.auth.signUp({ email, password: newUser.password });
    if (error) { setAdding(false); flash(`Couldn't create the account. ${authWhy(error.message)}`); return; }
    // Supabase hides duplicate emails behind a fake user with no identities
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setAdding(false); flash("That email already has an account. Change their role in the list below instead."); return;
    }
    const newId = data.user?.id;
    let roleWarn = "";
    if (newId) {
      // the profile row is created automatically; set the display name and role
      const patch: { name?: string; role?: Role; email?: string } = {};
      if (newUser.name.trim()) patch.name = newUser.name.trim();
      patch.role = newUser.role;
      // the signup trigger fills the email in too; writing it here means the
      // new row shows an address right away, and only when the column is there
      if (!noEmailCol) patch.email = email;
      // only an admin account can set roles: confirm the update really landed
      const { data: upd, error: pe } = await sb().from("profiles").update(patch).eq("id", newId).select("id");
      if (pe || !upd || upd.length === 0) roleWarn = " ⚠ The role didn't apply. Set it in the list below.";
    }
    setAdding(false); setAddOpen(false);
    setNewUser({ name: "", email: "", password: "", role: "office" });
    flash(`Account created for ${email}.${roleWarn}`);
    loadUsers();
  };

  // ---------- full backup: the whole business in one workbook ----------
  const [backingUp, setBackingUp] = useState(false);
  const allOf = async (table: string, optional = false): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let from = 0;
    for (;;) {
      // ordered, since unordered pages can overlap; and an error must fail the
      // backup loudly instead of downloading a silently short file
      const { data, error } = await sb().from(table).select("*").order("id").range(from, from + 999);
      if (error) {
        if (optional && /relation|does not exist|schema cache/i.test(error.message)) return out;
        throw Object.assign(new Error(`${table}: ${error.message}`), { table });
      }
      if (!data || data.length === 0) break;
      out.push(...(data as Record<string, unknown>[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  };
  const downloadBackup = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine. Check your signal and try again"); return; }
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
          Day: `${s.day}`, Release: r ? `#${r.rel_number} · ${r.location}` : "", Worker: eName.get(s.employee_id as string) || "?",
          Description: s.description || "", Address: s.address || "", Texted: s.texted ? "yes" : "",
        };
      }));
      const fname = askFileName(`earthlink_backup_${new Date().toISOString().slice(0, 10)}.xlsx`);
      if (fname) XLSX.writeFile(wb, fname);
    } catch (e) {
      const table = (e as { table?: string } | null)?.table;
      flash(table ? `Couldn't read the ${table} table for the backup. Check your signal and try again.` : "Couldn't build the backup. Check your signal and try again.");
    }
    setBackingUp(false);
  };

  // ---------- system check: is every upgrade in place? ----------
  type CheckResult = { label: string; fix: string; ok: boolean };
  // what a probe found out, for a fix line that names the missing piece
  const found: Record<string, string> = {};
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  // storage meter: how full the docs bucket is (via the storage_usage() function)
  const [storage, setStorage] = useState<{ bytes: number; files: number } | "missing" | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const checkStorage = async () => {
    setStorageBusy(true);
    const { data, error } = await sb().rpc("storage_usage");
    setStorageBusy(false);
    if (error) { setStorage(/function|schema cache|not.*found/i.test(error.message) ? "missing" : null); if (storage !== "missing" && !/function|schema cache|not.*found/i.test(error.message)) flash("Couldn't measure the storage. Check your signal and try again."); return; }
    const d = data as { bytes?: number; files?: number } | null;
    setStorage({ bytes: Number(d?.bytes) || 0, files: Number(d?.files) || 0 });
  };
  const [checking, setChecking] = useState(false);
  // the PO descriptions the first intake cut at 120 characters, read again from the PDFs on the jobs
  const [fixingDesc, setFixingDesc] = useState(false);
  type DescFixed = { id: string; po: string; after: string; crewRows?: number };
  type DescKept = { id: string; po: string; why: string };
  type DescReport = { checked: number; fixed: DescFixed[]; kept: DescKept[]; billed: number; readBefore: number };
  const [descReport, setDescReport] = useState<DescReport | null>(null);
  // what the rounds so far have done, kept across taps: a round the server
  // couldn't answer (it ran out of time) loses nothing, the next tap carries on
  const descAll = useRef<DescReport>({ checked: 0, fixed: [], kept: [], billed: 0, readBefore: 0 });
  const descDone = useRef<string[]>([]);
  const fixDescriptions = async () => {
    setFixingDesc(true);
    const all = descAll.current;
    try {
      const { data: { session } } = await sb().auth.getSession();
      for (let round = 0; round < 60; round++) {
        const r = await fetch("/api/fix-descriptions", { method: "POST", headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify({ done: descDone.current }) }).catch(() => null);
        const j = r ? ((await r.json().catch(() => null)) as { error?: string; checked?: number; fixed?: DescFixed[]; kept?: DescKept[]; remaining?: number; done?: string[]; skipped?: { billed?: number; readBefore?: number } } | null) : null;
        if (!r || !j) { flash("The server didn't answer in time. Tap the button again to carry on where it left off"); break; }
        if (!r.ok) { flash(j.error || `The server said ${r.status}. Try again in a moment`); break; }
        all.checked += j.checked || 0; all.fixed.push(...(j.fixed || []));
        // a job kept again on a later tap shows its newest reason once
        const keptNow = j.kept || [];
        all.kept = [...all.kept.filter((k) => !keptNow.some((n) => n.id === k.id)), ...keptNow];
        all.billed = Math.max(all.billed, j.skipped?.billed || 0); all.readBefore = Math.max(all.readBefore, j.skipped?.readBefore || 0);
        descDone.current = j.done || descDone.current;
        setDescReport({ ...all });
        if (!j.remaining || !j.checked) break;
      }
    } catch { flash("No signal, try again in a moment"); }
    setFixingDesc(false);
  };
  const runSystemCheck = async () => {
    setChecking(true); setChecks(null);
    // a fix that is just a file name gets "Run " in front of it on screen; the longer ones say it themselves
    const probes: { label: string; fix: string | (() => string); probe: () => Promise<boolean> }[] = [
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
      { label: "Company texting number (Twilio)", fix: () => found.twilio || "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (the number as +1 and ten digits) in Vercel → Settings → Environment Variables, then Redeploy. Texts fall back to your phone until then.", probe: async () => { try { const r = await fetch("/api/text"); const j = (await r.json()) as { configured?: boolean; problem?: string }; found.twilio = j.problem || ""; return !!j.configured && !j.problem; } catch { return false; } } },
      { label: "You're in a group thread with each crew", fix: () => found.group || "Add TEXT_COPY_TO (your cell, +1 and ten digits) and TWILIO_FROM (the company number, a local 10-digit one: Twilio can't group-text from a toll-free number) in Vercel → Settings → Environment Variables, then Redeploy. Each crew text then goes into one thread with you, the workers on that job and the company number; their photos, square feet and the portal's answers land there too. Until then every text is copied to your phone instead (once TEXT_COPY_TO is there).", probe: async () => { try { const r = await fetch("/api/text"); const j = (await r.json()) as { group?: boolean; groupProblem?: string }; found.group = j.groupProblem || ""; return !!j.group && !j.groupProblem; } catch { return false; } } },
      { label: "Each worker's language (Spanish texts)", fix: "Run RUN_ME.sql (section 18). Until then every crew text is in English.", probe: async () => !(await sb().from("employees").select("lang").limit(1)).error },
      { label: "A crew text set up for later", fix: "Run RUN_ME.sql (section 19). Until then a text can only be sent right now.", probe: async () => !(await sb().from("schedule_days").select("send_at").limit(1)).error },
      { label: "Set-up texts go out on their own", fix: "Add CRON_SECRET (any long random string) and SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API → service_role) in Vercel → Settings → Environment Variables, then Redeploy. Even then, a free Vercel plan only lets the timer run once a day (it refuses to deploy anything more often), so a text set for a particular hour really goes out the next time somebody has the portal open, which the office usually does each morning. On a paid plan, change the schedule in vercel.json to */15 * * * * and they go out on their own, on the quarter hour.", probe: async () => { try { const r = await fetch("/api/text-due"); return !!((await r.json()) as { onItsOwn?: boolean }).onItsOwn; } catch { return false; } } },
      { label: "Photos the crew texts back go on the job", fix: () => `${found.photos ? `${found.photos}. The whole setup: ` : ""}Run RUN_ME.sql (section 20), and add SUPABASE_SERVICE_ROLE_KEY in Vercel (Supabase → Settings → API → service_role), then Redeploy. Then in Twilio: Phone Numbers → Active numbers → the company number → Messaging → "A message comes in": Webhook, HTTP POST, ${window.location.origin}/api/sms-in (typed exactly, no slash at the end) → Save. If the number is inside a Messaging Service, set that on the service instead: Messaging → Services → the service → Integration → "Send a webhook" to the same address. Last, text the company number once from any phone: that switches it on, and from then on every crew text ends with "Reply to this text with photos of the work."`, probe: async () => { try { const r = await fetch("/api/sms-in"); const j = (await r.json()) as { on?: boolean; why?: string }; found.photos = j.why || ""; return !!j.on; } catch { return false; } } },
      { label: "Nobody-home marks and when each text went", fix: "Run RUN_ME.sql (section 21). Until then a ⚠ Nobody home mark doesn't clear itself and a worker's \"no\" right after an evening text counts as a door.", probe: async () => !(await sb().from("schedule_days").select("texted_at").limit(1)).error },
      { label: "PACT crew on the day schedule", fix: "Run RUN_ME.sql (section 14). Until then a PACT crew is matched to its job by day and address only.", probe: async () => !(await sb().from("schedule_days").select("pact_job_id").limit(1)).error },
      { label: "Smart reader (Claude): POs and surveys", fix: "Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then Redeploy. POs and surveys are read by the portal's own reader until then. A key made for more than one workspace also needs ANTHROPIC_WORKSPACE_ID, or make the key for one workspace in the Claude Console.", probe: async () => { try { const r = await fetch("/api/parse-po"); return !!((await r.json()) as { smart?: boolean }).smart; } catch { return false; } } },
      { label: "PACT schedule dates", fix: "upgrade_schedule.sql", probe: async () => !(await sb().from("pact_jobs").select("start_date,finish_date").limit(1)).error },
      { label: "PACT jobs & invoicing", fix: "upgrade_pact.sql", probe: async () => !(await sb().from("pact_jobs").select("id,po_number,items,tax_pct,invoice_number").limit(1)).error },
    ];
    const results: CheckResult[] = [];
    for (const p of probes) {
      let ok = false;
      try { ok = await p.probe(); } catch { ok = false; }
      results.push({ label: p.label, fix: typeof p.fix === "function" ? p.fix() : p.fix, ok });
    }
    setChecks(results); setChecking(false);
  };

  // the one bit of the page that is always there: the letterhead card holds its shape while the company row loads
  if (!org) return (
    <div>
      <PageHeader title="Settings" />
      <Disclosure label="Company letterhead" sublabel="name, address, license" defaultOpen>
        <div className="card card-pad grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Loading">
          {FIELDS.map(([k]) => <div key={k} className="skeleton h-11 w-full" />)}
        </div>
      </Disclosure>
    </div>
  );
  const canEditCrew = me?.role !== "accountant";
  const activeCrew = emps.filter((e) => e.active !== false);
  return (
    <div>
      {(backingUp || fixingDesc || checking) && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Settings" />

      <Disclosure label="Company letterhead" sublabel="name, address, license" defaultOpen>
        <div className="card card-pad grid gap-3 md:grid-cols-2">
          {FIELDS.map(([k, label, hint]) => (
            <div key={k}>
              <label className="section-label mb-1" htmlFor={`org-${k}`}>{label}</label>
              <input id={`org-${k}`} className="field" placeholder={hint} value={org[k] || ""}
                onChange={(e) => setOrg({ ...org, [k]: e.target.value })} onBlur={(e) => save(k, e.target.value)} onKeyDown={blurOnEnter} />
            </div>
          ))}
        </div>
        <div className="mt-2 text-[12px] text-inksoft">Every walk sheet, proposal, SOS form, invoice and statement carries this letterhead. Fields save when you tap out of them.</div>
      </Disclosure>

      {contracts.length > 0 && (
        <Disclosure label="Contract names" sublabel="what the dropdowns call them" className="mt-4">
          <div className="card divide-y divide-rulesoft">
            {contracts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-3">
                <span className="w-28 shrink-0 font-mono text-[13px] font-semibold">{c.number}</span>
                <input className="field" placeholder="e.g. Queensbridge IDIQ" aria-label={`Name for contract ${c.number}`}
                  defaultValue={c.name && c.name !== c.number ? c.name : ""}
                  onBlur={(e) => renameContract(c, e.target.value)} onKeyDown={blurOnEnter} />
              </div>
            ))}
          </div>
          <div className="mt-2 text-[12px] text-inksoft">Give contracts a name you recognize: dropdowns everywhere show the name instead of just the number. Leave blank to show the number.</div>
        </Disclosure>
      )}

      <Disclosure id="crew" label="Crew" sublabel="phone numbers and the language for texts" className="mt-4" open={crewOpen} onToggle={() => setCrewOpen(!crewOpen)}>
        <div className="card card-pad">
          <div className="mb-2 text-[12px] text-inksoft">The numbers the Schedule tabs text, and the language each worker gets their texts in. Numbers save when you tap out of the field.</div>
          {canEditCrew && (
            <form className="grid grid-cols-2 gap-2 md:grid-cols-5" onSubmit={addWorker}>
              <input className="field" placeholder="Name" autoComplete="off" value={crewDraft.name} onChange={(e) => setCrewDraft({ ...crewDraft, name: e.target.value })} />
              <input className="field" placeholder="Classification" autoComplete="off" value={crewDraft.trade} onChange={(e) => setCrewDraft({ ...crewDraft, trade: e.target.value })} />
              <input className="field" placeholder="Phone" inputMode="tel" enterKeyHint="done" autoComplete="off" value={crewDraft.phone} onChange={(e) => setCrewDraft({ ...crewDraft, phone: e.target.value })} />
              {langPick(crewDraft.lang, (l) => setCrewDraft({ ...crewDraft, lang: l }))}
              <button type="submit" className="btn btn-primary">Add</button>
            </form>
          )}
          <div className="mt-2 divide-y divide-rulesoft">
            {!empsLoaded && <SkeletonRows />}
            {activeCrew.map((e) => {
              const buf = phoneBuf[e.id] ?? prettyPhone(e.phone || "");
              // one row per worker: name and classification, the phone box, the language switch, the row menu
              // (on a phone the menu sits by the name and the phone box and switch share the second line)
              return (
                <div key={e.id} className="anim-row flex flex-wrap items-center gap-2 p-3 md:flex-nowrap">
                  <div className="min-w-0 flex-1 basis-48 text-[14px]"><b>{e.name}</b>{e.trade ? <span className="ml-2 text-[12px] text-inksoft">{e.trade}</span> : null}</div>
                  <input className="field order-3 w-auto flex-1 basis-32 md:order-none md:w-44 md:flex-none" placeholder="Phone" aria-label={`Phone for ${e.name}`} inputMode="tel" readOnly={!canEditCrew}
                    value={buf} onChange={(ev) => setPhoneBuf((p) => ({ ...p, [e.id]: ev.target.value }))}
                    onBlur={() => { if (cleanPhone(buf) !== cleanPhone(e.phone || "")) savePhone(e.id, buf); }} onKeyDown={blurOnEnter} />
                  <span className="order-4 md:order-none">{langPick(langOf(e.lang), (l) => saveLang(e.id, l), !canEditCrew, `Language for ${e.name}`)}</span>
                  {canEditCrew && (
                    <span className="order-2 md:order-last">
                      <RowActions items={[{
                        label: "Remove from the crew…",
                        destructive: true,
                        confirm: `Remove ${e.name} from the crew?`,
                        onSelect: async () => { await sb().from("employees").update({ active: false }).eq("id", e.id); loadEmps(); },
                      }]} />
                    </span>
                  )}
                </div>
              );
            })}
            {empsLoaded && activeCrew.length === 0 && <div className="pt-3"><div className="empty anim-fade">No crew yet. Add workers above.</div></div>}
          </div>
        </div>
      </Disclosure>

      {contracts.length > 0 && me?.role !== "accountant" && (
        <Disclosure label="Invoice package details" sublabel="wording on the package documents" className="mt-4">
          <div className="card card-pad">
            <div className="mb-3 text-[12px] text-inksoft">
              What gets written onto the package documents (REP, Section 3 hiring summary, Equal Opportunity report)
              for each contract. The contract number always fills in by itself: these are the parts that differ per
              contract. Blank fields keep the standard wording. Saved changes apply to every package made after that.
            </div>
            <div className="mb-3 max-w-sm">
              <div className="section-label mb-1">Contract</div>
              <ContractPicker contracts={contracts} value={pkgSel} onChange={setPkgSel} />
            </div>
            {pkgLoading ? (
              <div className="grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Loading">
                <div className="skeleton h-14 w-full" />
                <div className="skeleton h-11 w-full" />
                <div className="skeleton h-14 w-full md:col-span-2" />
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 anim-fade">
                <div>
                  <label className="section-label mb-1" htmlFor="pkg-development">Development / work description (REP + hiring summary)</label>
                  <textarea id="pkg-development" className="field min-h-[56px]" placeholder={PKG_DEFAULTS.development}
                    value={pkgInfo.development || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, development: e.target.value })} />
                </div>
                <div>
                  <label className="section-label mb-1" htmlFor="pkg-amount">Contract amount (REP + hiring summary)</label>
                  <input id="pkg-amount" className="field" placeholder={PKG_DEFAULTS.amount}
                    value={pkgInfo.amount || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, amount: e.target.value })} />
                </div>
                <div className="md:col-span-2">
                  <label className="section-label mb-1" htmlFor="pkg-eo">Project name &amp; no. (Equal Opportunity report header)</label>
                  <textarea id="pkg-eo" className="field min-h-[56px]" placeholder={PKG_DEFAULTS.eoProject}
                    value={pkgInfo.eoProject || ""} onChange={(e) => setPkgInfo({ ...pkgInfo, eoProject: e.target.value })} />
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-primary" onClick={savePkgDetails} disabled={pkgSaving || pkgLoading}>{pkgSaving ? "Saving…" : "Save package details"}</button>
              <span className="text-[12px] text-inksoft">The affidavit and full replacement PDFs upload on the Invoice Package tab.</span>
            </div>
          </div>
        </Disclosure>
      )}

      {/* the PACT price book and addressee price every PACT paper: Admin 1's alone,
          same as the PACT tab itself */}
      {me && me.role === "admin" && (
        <Disclosure label="Line items & prices" sublabel="what a PO turns into" className="mt-4">
          <div className="card card-pad">
            <div className="mb-2 text-[12px] text-inksoft">
              These are the lines a PO gets turned into: the prices quoted to Fairstead and Boulevard, plus anything you
              add of your own. Upload a PO and whatever it asks for lands on the job and on the proposal, priced from
              here. Plaster brings its primer and paint along with it. Painting is priced per apartment, one coat or two.
              {showWords ? " The wording box is what a PO has to say to pick that line: plain words, separated by commas, e.g. \"textured ceiling, stipple\"." : ""}
            </div>
            <div className="mb-3">
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showWords} onClick={() => setShowWords(!showWords)}>
                {showWords ? "Hide PO wording" : "Show PO wording"}
              </button>
            </div>
            {[...PRICE_GROUPS, CUSTOM_GROUP].map((g) => {
              const rows = g === CUSTOM_GROUP ? [] : PRICE_BOOK.filter((p) => p.group === g);
              if (g !== CUSTOM_GROUP && rows.length === 0) return null;
              return (
                <div key={g} className="mb-3">
                  <div className="section-label mb-1">{g}</div>
                  <div className="card divide-y divide-rulesoft">
                    {rows.map((p) => {
                      const o = ovOf(p.key);
                      const off = !!o.off;
                      return (
                        <div key={p.key} className={`p-3 ${off ? "opacity-45" : ""}`}>
                          {/* two fixed rows: the words, then the numbers, so everything lines up.
                              On a phone the second price drops under the first; the switch stays at the right */}
                          <input className="field w-full px-2 text-[13px]" value={o.description ?? p.description} aria-label={`Wording for ${p.description}`}
                            placeholder={p.description} onChange={(e) => setOv(p.key, { description: e.target.value })} />
                          <div className="mt-1.5 grid grid-cols-[96px_1fr_64px] items-center gap-2 md:grid-cols-[96px_1fr_1fr_64px]">
                            <select className="field w-full px-1 text-center text-[13px]" aria-label="Unit"
                              value={o.unit ?? p.unit} onChange={(e) => setOv(p.key, { unit: e.target.value })}>
                              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                            <label className="flex min-w-0 items-center gap-1">
                              {p.price2 !== undefined && <span className="whitespace-nowrap text-[11px] text-inksoft">1 coat</span>}
                              <span className="text-sm">$</span>
                              <input className="field w-full min-w-0 px-2 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${p.key}:price`, o.price, p.price)} />
                            </label>
                            {p.price2 !== undefined ? (
                              <label className="col-start-2 flex min-w-0 items-center gap-1 md:col-start-auto">
                                <span className="whitespace-nowrap text-[11px] text-inksoft">2 coats</span>
                                <span className="text-sm">$</span>
                                <input className="field w-full min-w-0 px-2 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${p.key}:price2`, o.price2, p.price2)} />
                              </label>
                            ) : <span className="hidden md:block" />}
                            <button type="button" aria-pressed={!off}
                              className={`col-start-3 row-start-1 min-h-[44px] whitespace-nowrap rounded-sm text-[11px] font-semibold uppercase tracking-wide transition-colors active:bg-paper md:col-start-auto md:row-start-auto ${off ? "text-work" : "text-inksoft"}`}
                              onClick={() => setOv(p.key, { off: !off })}>{off ? "Not used" : "In use"}</button>
                          </div>
                          {showWords && (
                            <input className="field mt-1.5 px-2 text-[12px] anim-open" value={o.extra || ""} aria-label={`Other PO wording for ${p.description}`}
                              placeholder="Other words a PO might use"
                              onChange={(e) => setOv(p.key, { extra: e.target.value })} />
                          )}
                        </div>
                      );
                    })}
                    {g === CUSTOM_GROUP && !priceLoaded && !priceLoadErr && <SkeletonRows />}
                    {g === CUSTOM_GROUP && store.custom.map((c) => (
                      <div key={c.key} className="anim-row p-3">
                        <input className="field w-full px-2 text-[13px]" value={c.description} aria-label="What the line says on the invoice"
                          placeholder="What the line says on the invoice" onChange={(e) => setCustom(c.key, { description: e.target.value })} />
                        <div className="mt-1.5 grid grid-cols-[96px_1fr_64px] items-center gap-2 md:grid-cols-[96px_1fr_1fr_64px]">
                          <select className="field w-full px-1 text-center text-[13px]" aria-label="Unit"
                            value={c.unit} onChange={(e) => setCustom(c.key, { unit: e.target.value })}>
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <label className="flex min-w-0 items-center gap-1">
                            <span className="text-sm">$</span>
                            <input className="field w-full min-w-0 px-2 text-right font-mono text-[13px]" inputMode="decimal" {...moneyBox(`${c.key}:price`, c.price || undefined, 0)} />
                          </label>
                          <span className="hidden md:block" />
                          <button type="button" className="btn-icon text-alert" aria-label="Remove this line item"
                            onClick={() => { if (window.confirm("Remove this line item?")) removeCustom(c.key); }}>✕</button>
                        </div>
                        <input className={`field mt-1.5 px-2 text-[12px] ${c.description.trim() && !keywordsRe(c.words) ? "border-work" : ""}`} value={c.words} aria-label="What a PO says for this line"
                          placeholder={`What a PO says for this, plain words with commas: "move out, moveout clean"`}
                          onChange={(e) => setCustom(c.key, { words: e.target.value })} />
                        {c.description.trim() && !keywordsRe(c.words) && (
                          <div className="mt-1 text-[11px] text-work">Needs wording of at least two letters, or a PO can never pick this line.</div>
                        )}
                      </div>
                    ))}
                    {g === CUSTOM_GROUP && (priceLoaded || priceLoadErr) && store.custom.length === 0 && (
                      <div className="p-3"><div className="empty anim-fade">Nothing of your own yet. Tap + Add line item for work the partners&apos; sheet doesn&apos;t cover.</div></div>
                    )}
                  </div>
                  {g === CUSTOM_GROUP && (
                    <button type="button" className="btn btn-ghost mt-2 min-h-[44px]" onClick={addCustom}>+ Add line item</button>
                  )}
                </div>
              );
            })}
            {/* a partner's purchase order prints their office, not the person
                at it: this is who a proposal is addressed to when the PO
                doesn't name anybody */}
            <div className="mb-3 border-t border-rulesoft pt-3">
              <div className="section-label">Proposals are addressed to</div>
              <div className="mt-1 text-[12px] text-inksoft">Whoever the PO names at the office comes first. This is who it goes to otherwise. Clear both to leave proposals unaddressed.</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <input className="field w-56" placeholder="Name" aria-label="Addressee name"
                  value={store.attn?.name ?? DEFAULT_ATTN.name}
                  onChange={(e) => { setStore((p) => ({ ...p, attn: { title: DEFAULT_ATTN.title, ...(p.attn || {}), name: e.target.value } })); setPriceTouched(true); }} />
                <input className="field w-56" placeholder="Title" aria-label="Addressee title"
                  value={store.attn?.title ?? DEFAULT_ATTN.title}
                  onChange={(e) => { setStore((p) => ({ ...p, attn: { name: DEFAULT_ATTN.name, ...(p.attn || {}), title: e.target.value } })); setPriceTouched(true); }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {priceLoadErr && (
                <button type="button" className="btn" onClick={readList}>Couldn&apos;t read the saved list. Try again</button>
              )}
              <button type="button" className="btn btn-ghost" disabled={!priceLoaded} onClick={() => { setStore(EMPTY_STORE); setPriceText({}); setPriceTouched(true); flash("Back to the sheet as it came. Save to keep it"); }}>Reset to the sheet</button>
              <span className="text-[12px] text-inksoft">Changes save from the bar below once you touch something.</span>
            </div>
          </div>
        </Disclosure>
      )}

      {me?.role === "admin" && (
        <Disclosure label="Users & roles" sublabel="who can sign in, and as what" className="mt-4">
          {noEmailCol && (
            <div className="notice-work mb-2 text-inksoft">
              Run <span className="font-mono">supabase/upgrade_user_email.sql</span> in Supabase to see everyone&rsquo;s email address here.
            </div>
          )}
          <div className="card divide-y divide-rulesoft">
            {/* adding someone is the first row of the list: a button, or the form once it is tapped */}
            <div className="p-3">
              {addOpen ? (
                <form className="anim-open" onSubmit={addUser}>
                  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                    <div><label className="section-label mb-1" htmlFor="new-user-name">Name</label>
                      <input id="new-user-name" className="field" autoFocus autoComplete="off" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></div>
                    <div><label className="section-label mb-1" htmlFor="new-user-email">Email</label>
                      <input id="new-user-email" className="field" type="email" inputMode="email" autoCapitalize="none" autoComplete="off" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
                    <div><label className="section-label mb-1" htmlFor="new-user-password">Password</label>
                      <input id="new-user-password" className="field" autoComplete="new-password" enterKeyHint="done" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
                      <div className="mt-1 text-[11px] text-inksoft">Shown so you can read it to them.</div></div>
                    <div><label className="section-label mb-1" htmlFor="new-user-role">Role</label>
                      <select id="new-user-role" className="field" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
                        {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                      </select></div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="submit" className="btn btn-primary" disabled={adding}>{adding ? "Creating…" : "Create account"}</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
                  </div>
                  <div className="mt-2 text-[12px] text-inksoft">Give them this email + password to sign in. You can change their role any time below.</div>
                </form>
              ) : (
                <button type="button" className="btn btn-ghost w-full sm:w-auto" onClick={() => setAddOpen(true)}>+ Add user</button>
              )}
            </div>
            {!peopleLoaded && <SkeletonRows />}
            {people.map((p) => (
              <div key={p.id} className="anim-row flex flex-wrap items-center gap-2 p-3 md:flex-nowrap">
                <div className="min-w-[180px] flex-1">
                  <input className="field text-sm font-medium" placeholder="Name" aria-label={`Name for ${p.email || p.name || "this account"}`}
                    value={nameBuf[p.id] ?? p.name ?? ""}
                    onChange={(e) => setNameBuf({ ...nameBuf, [p.id]: e.target.value })}
                    onBlur={() => saveName(p)}
                    onKeyDown={blurOnEnter} />
                  <div className="mt-1 truncate text-[11px] text-inksoft">
                    {p.email || (noEmailCol ? p.id.slice(0, 8) : "no email on file")}
                    {p.id === me.id && <span className="ml-2">(you)</span>}
                  </div>
                </div>
                <select className="field order-3 w-full md:order-none md:w-56" aria-label={`Role for ${p.name || p.email || "this account"}`} value={p.role} onChange={(e) => changeRole(p, e.target.value as Role)}>
                  {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                  {!ROLE_OPTIONS.some(([r]) => r === p.role) && <option value={p.role}>{ROLE_LABEL[p.role] || p.role} (old role)</option>}
                </select>
                {p.email && (
                  <span className="order-2 md:order-last">
                    <RowActions items={[{
                      label: "Reset password",
                      title: "Sends them a link to pick a new password",
                      disabled: resetBusy,
                      confirm: `Send ${p.email} a link to pick a new password?`,
                      onSelect: () => sendResetTo(p.email || ""),
                    }]} />
                  </span>
                )}
              </div>
            ))}
            {peopleLoaded && people.length === 0 && <div className="p-3"><div className="empty anim-fade">Nobody here yet. Tap + Add user to make an account.</div></div>}
          </div>
          <div className="mt-2 text-[12px] text-inksoft">If they can&apos;t sign in yet, they may need to open the confirmation email, or turn off &ldquo;Confirm email&rdquo; in Supabase → Authentication → Providers.</div>
        </Disclosure>
      )}

      {/* one System card: storage, backup, health check. Three rows, one place */}
      <Disclosure label="System" sublabel="storage, backup, health check" className="mt-4">
      <div className="card divide-y divide-rulesoft">
      <div className="card-pad text-[14px]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-semibold">File storage</div>
            <div className="text-[12px] text-inksoft">How full the photo &amp; document storage is.</div>
          </div>
          <button type="button" className="btn btn-ghost w-full whitespace-nowrap sm:w-auto" onClick={checkStorage} disabled={storageBusy}>{storageBusy ? "Measuring…" : "Check storage"}</button>
        </div>
        {storageBusy && <div className="skeleton mt-2.5 h-2 w-full" aria-hidden />}
        {storage === null && !storageBusy && (
          <div className="mt-2 text-[12px] text-inksoft">The free Supabase plan includes 1 GB. Upgrade only when this gets near the top.</div>
        )}
        {storage === "missing" && (
          <div className="mt-2 text-inksoft">Run <span className="font-mono">supabase/upgrade_storage_meter.sql</span> (it&apos;s in RUN_ME.sql too) to turn on the storage meter.</div>
        )}
        {storage !== null && storage !== "missing" && (() => {
          const gb = 1024 * 1024 * 1024;
          const pct = Math.min(100, Math.round((storage.bytes / gb) * 100));
          const mb = Math.round(storage.bytes / 1024 / 1024);
          const tone = pct < 60 ? "text-ok" : pct < 85 ? "text-work" : "text-alert";
          return (
            <div className="anim-fade">
              <div className="mb-1.5 mt-2.5 flex items-baseline justify-between">
                <span className="font-mono font-semibold">{mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(2)} GB`} of 1 GB</span>
                <span className={`font-mono text-[12px] font-semibold ${tone}`}>{pct}% · {storage.files.toLocaleString()} files</span>
              </div>
              <div className="h-2 w-full rounded-sm bg-rulesoft">
                <div className={`h-2 rounded-sm ${pct < 60 ? "bg-ok" : pct < 85 ? "bg-work" : "bg-alert"}`} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              <div className="mt-1.5 text-[12px] text-inksoft">
                {pct < 60 && "Plenty of room. No need to upgrade Supabase."}
                {pct >= 60 && pct < 85 && "Getting fuller. Fine for now, but plan on Supabase Pro ($25/mo, 100 GB) in the coming months."}
                {pct >= 85 && "Nearly full. Upgrade to Supabase Pro ($25/mo, 100 GB) soon, or new photo uploads will start failing."}
                {" "}On Supabase Pro the limit is 100 GB. This bar reads against 1 GB.
              </div>
            </div>
          );
        })()}
      </div>

      <div className="card-pad text-[14px]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-semibold">Backup</div>
            <div className="text-[12px] text-inksoft">One Excel workbook with everything. Worth downloading every Friday and keeping somewhere safe.</div>
          </div>
          <button type="button" className="btn btn-ghost w-full whitespace-nowrap sm:w-auto" onClick={downloadBackup} disabled={backingUp}>{backingUp ? "Building…" : "⬇ Full backup (Excel)"}</button>
        </div>
      </div>

      <div className="card-pad">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[14px] font-semibold">System check</div>
            <div className="text-[12px] text-inksoft">Verifies the database has every upgrade in place.</div>
          </div>
          <button type="button" className="btn btn-ghost w-full whitespace-nowrap sm:w-auto" onClick={runSystemCheck} disabled={checking}>{checking ? "Checking…" : "Run system check"}</button>
        </div>
        {me?.role === "admin" && (
          <div className="mt-3 flex flex-col gap-3 border-t border-rulesoft pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[14px] font-semibold">PO descriptions</div>
              <div className="text-[12px] text-inksoft">Jobs whose description was cut short when the PO was read (120 characters) get it read again from the PDF on the job. Nothing else on the job changes.</div>
            </div>
            <button type="button" className="btn btn-ghost w-full whitespace-nowrap sm:w-auto" onClick={fixDescriptions} disabled={fixingDesc} data-fix-descriptions>{fixingDesc ? "Reading…" : "Re-read descriptions"}</button>
          </div>
        )}
        {descReport && (
          <div className="mt-2 text-[14px] anim-fade" data-desc-report>
            <div className="font-semibold">{descReport.checked === 0 ? "No cut descriptions found." : `${descReport.fixed.length} of ${descReport.checked} fixed.`}</div>
            {descReport.billed > 0 && <div className="mt-1 text-[12px] text-inksoft">{descReport.billed === 1 ? "1 job that is already invoiced or paid has a cut description; it was left alone." : `${descReport.billed} jobs that are already invoiced or paid have a cut description; they were left alone.`}</div>}
            {descReport.readBefore > 0 && <div className="mt-1 text-[12px] text-inksoft">{descReport.readBefore === 1 ? "1 job was read once already since the portal last started and was left as it is." : `${descReport.readBefore} jobs were read once already since the portal last started and were left as they are.`}</div>}
            {descReport.fixed.map((f) => <div key={f.id} className="mt-1 text-[12px]"><b>{f.po}</b> · {f.after}{f.crewRows ? ` · ${f.crewRows === 1 ? "1 crew row" : `${f.crewRows} crew rows`} updated` : ""}</div>)}
            {descReport.kept.map((k) => <div key={k.id} className="mt-1 text-[12px] text-inksoft"><b>{k.po}</b> · {k.why}</div>)}
          </div>
        )}
        {checks === null && !checking && <div className="mt-2 text-[12px] text-inksoft">If something&apos;s missing it names the exact SQL file to paste into Supabase, or just run <span className="font-mono">supabase/RUN_ME.sql</span> to apply everything at once.</div>}
        {checking && (
          <div className="mt-2 divide-y divide-rulesoft" aria-busy="true" aria-label="Checking">
            {[0, 1, 2].map((i) => <div key={i} className="py-2.5"><div className="skeleton h-4 w-2/3" /></div>)}
          </div>
        )}
        {checks !== null && (
          <div className="mt-2 anim-fade">
            {checks.map((c) => {
              // a bare file name reads "Run x.sql"; a long how-to folds away until it is wanted
              const text = /\.sql$/i.test(c.fix) ? `Run ${c.fix}` : c.fix;
              const long = text.length > 150;
              return (
                <div key={c.label} className="border-t border-rulesoft py-2 first:border-t-0">
                  <div className="text-[14px]"><span className={c.ok ? "text-ok" : "text-alert"}>{c.ok ? "✓" : "✕"}</span> {c.label}</div>
                  {!c.ok && (long
                    ? <Disclosure label="How to fix" className="mt-1"><div className="pb-2 pl-1 text-[13px] leading-snug">{mono(text)}</div></Disclosure>
                    : <div className="mt-1 text-[13px] leading-snug">{mono(text)}</div>)}
                </div>
              );
            })}
            <div className="mt-2 border-t border-rulesoft pt-2 text-[14px] font-semibold">
              {checks.every((c) => c.ok)
                ? <span className="text-ok">Everything is set up. All upgrades are in place. ✓</span>
                : <span className="text-alert">{checks.filter((c) => !c.ok).length === 1 ? "1 item missing" : `${checks.filter((c) => !c.ok).length} items missing`}. Easiest fix: paste <span className="font-mono">supabase/RUN_ME.sql</span> into the Supabase SQL Editor and Run.</span>}
            </div>
            <div className="mt-1 text-[12px] text-inksoft">Live updates can&apos;t be checked from here. If screens don&apos;t refresh on their own after everything above is green, run <span className="font-mono">upgrade_realtime.sql</span> (it&apos;s included in RUN_ME.sql).</div>
          </div>
        )}
      </div>
      </div>
      </Disclosure>

      {/* the Save button can never scroll out of reach while prices are dirty */}
      <SaveBar visible={priceTouched} label="Save line items" saving={priceSaving}
        onSave={savePriceList} hint={priceLoaded ? "Line items and prices: not saved yet" : "Still reading the saved list…"} />

      <Toast msg={msg} />
    </div>
  );
}

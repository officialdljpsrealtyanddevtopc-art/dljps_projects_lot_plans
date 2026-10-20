// Pure sheet-sync logic, ported 1:1 from LOT_MANAGER_V7.html (plan/apply/typeFor/findKey/roster).
// No I/O in this file so it can be unit-tested and reused by the Edge Function.

export type IndexRow = { map_id: string; block: string; lot: string; key: string };
export type LotType = { id: string; name: string; rate: number };
export type Member = { n: string; t: string; p: string };
export type Lot = Record<string, unknown>;
export type Patch = Record<string, unknown>;

export const nk = (s: unknown) =>
  String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const nb = (s: unknown) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
export const num = (s: unknown) => {
  const t = String(s == null ? "" : s).replace(/[^0-9.\-]/g, "");
  if (!/\d/.test(t)) return NaN;
  return parseFloat(t);
};

export function parseCSV(t0: string): string[][] {
  const R: string[][] = [];
  let r: string[] = [], f = "", q = false;
  const t = String(t0).replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c == '"') { if (t[i + 1] == '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c == '"') q = true;
    else if (c == ",") { r.push(f); f = ""; }
    else if (c == "\n" || c == "\r") { if (c == "\r" && t[i + 1] == "\n") i++; r.push(f); f = ""; R.push(r); r = []; }
    else f += c;
  }
  if (f !== "" || r.length) { r.push(f); R.push(r); }
  return R.filter((x) => x.some((v) => String(v).trim() !== ""));
}

export function tcase(s0: unknown) {
  let s = String(s0 || "").replace(/\s+/g, " ").trim().toLowerCase();
  s = s.replace(/(^|[\s.\-\/'(])([a-zñáéíóúü])/g, (_m, a, b) => a + b.toUpperCase());
  return s.replace(/\b(Ii|Iii|Iv|Vi)\b/g, (x) => x.toUpperCase());
}

export function phone(s: unknown) {
  let d = String(s || "").split(/[\/,;]/)[0].replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d[0] == "+") return d;
  if (d.length == 10 && d[0] == "9") return "0" + d;
  if (d.length == 11 && d.slice(0, 2) == "09") return d;
  if (d.length >= 11 && d.slice(0, 2) == "63") return "+" + d;
  if (d.length >= 11 && /^(971|973|966|965|974|968|44|1|65|852|81)/.test(d)) return "+" + d;
  return d;
}

export const isoOK = (s0: unknown) => {
  const s = String(s0 || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2015 || y > 2040 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return s;
};

export const pct = (s: unknown) => {
  if (!/\d/.test(String(s || ""))) return NaN;
  const v = num(s);
  return v >= 0 && v <= 100 ? v : NaN;
};

export const mapOf = (p0: unknown) => {
  const p = nk(p0);
  if (!p) return "";
  if (p.indexOf("granja") == 0) return p.indexOf("coming") >= 0 ? "" : "m2";
  if (p == "prayermountainvalleyiii") return "m3";
  if (p == "prayermountainvalleyii") return "m1";
  return "";
};

// ---- lot lookup --------------------------------------------------------
type Idx = Record<string, { x: Record<string, string[]>; b: Record<string, string[]> }>;
export function buildIdx(rows: IndexRow[]) {
  const IDX: Idx = {};
  const m1 = new Set<string>();
  for (const r of rows) {
    if (r.map_id == "m1") { m1.add(r.key); continue; }
    const I = (IDX[r.map_id] ||= { x: {}, b: {} });
    const bs = (r.block.match(/^\d+/) || [""])[0];
    (I.x[r.block + "|" + r.lot] ||= []).push(r.key);
    (I.b[bs + "|" + r.lot] ||= []).push(r.key);
  }
  return { IDX, m1 };
}
export type Lookup = ReturnType<typeof buildIdx>;

export function findKey(L: Lookup, mid: string, block: string, lot: string): { key?: string; err?: string } {
  if (mid == "m1") {
    const b = parseInt(block, 10), l = parseInt(lot, 10);
    if (!(b > 0 && l > 0) || String(b) !== String(block).trim()) return { err: "nolot" };
    const k = b + "-" + l;
    return L.m1.has(k) ? { key: k } : { err: "nolot" };
  }
  const I = L.IDX[mid];
  if (!I) return { err: "nomap" };
  const bl = nb(block), lo = nb(lot);
  if (!lo) return { err: "nolot" };
  let c = I.x[bl + "|" + lo];
  if (c && c.length == 1) return { key: c[0] };
  if (c && c.length > 1) return { err: "amb" };
  if (/^\d+$/.test(bl)) {
    c = I.b[bl + "|" + lo];
    if (c && c.length == 1) return { key: c[0] };
    if (c && c.length > 1) return { err: "amb" };
  }
  return { err: "nolot" };
}

// ---- team roster (TEAM tab) ----------------------------------------------
const toks = (s: unknown) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function rowsToRoster(rows: string[][]): Member[] {
  const H = rows[0].map(nk), ix = (n: string) => H.indexOf(n);
  const C = { n: ix("name"), t: ix("team"), p: ix("position"), s: ix("status") };
  if (C.n < 0 || C.t < 0) throw new Error("Roster tab needs columns named Name and Team (optional: Position, Status).");
  const out: Member[] = [], seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const g = (c: number) => (c < 0 ? "" : String(r[c] == null ? "" : r[c]).replace(/\s+/g, " ").trim());
    const n = g(C.n), t = g(C.t);
    if (!n || !t) continue;
    if (/^(inactive|resigned|terminated|left|no|x)$/i.test(g(C.s))) continue;
    const p = /leader|head|manager|vp|president/i.test(g(C.p)) ? "Team Leader" : "Agent";
    const k = nk(t) + "|" + nk(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ n, t, p });
  }
  if (!out.length) throw new Error("No usable rows found in the roster tab.");
  return out;
}

export function makeResolver(list: Member[]) {
  const M = list.map((m) => ({ ...m, k: toks(m.n).sort().join(" "), tk: new Set(toks(m.n)) }));
  const byKey = new Map<string, (typeof M)[number]>();
  for (const m of M) if (!byKey.has(m.k)) byKey.set(m.k, m);
  const cache = new Map<string, string>();
  return (a0: string) => {
    const a = String(a0 || "").trim();
    if (!a || !M.length) return "";
    if (cache.has(a)) return cache.get(a)!;
    const t = toks(a);
    let r = byKey.get(t.slice().sort().join(" ")) || null;
    if (!r && t.length >= 2) {
      const c = new Map<string, (typeof M)[number]>();
      for (const m of M) {
        const big = m.tk.size >= 2 && (t.every((x) => m.tk.has(x)) || [...m.tk].every((x) => t.includes(x)));
        if (big && !c.has(m.k)) c.set(m.k, m);
      }
      if (c.size == 1) r = [...c.values()][0];
    }
    const out = r ? r.n : "";
    cache.set(a, out);
    return out;
  };
}

// ---- plan: sheet rows -> per-lot desired values ----------------------------
export type Stats = {
  rows: number; noMap: number; noLot: number; amb: number; otherStatus: number; dup: number; used: number;
  amb_list: string[]; lots?: number; fields?: number;
};
export type Ctx = { lookup: Lookup; types: LotType[]; resolveAgent?: (a: string) => string };

function typeFor(types: LotType[], rate: number) {
  let t = types.find((y) => Math.round(+y.rate) === Math.round(rate));
  if (!t) {
    t = { id: "s" + Math.round(rate), name: "₱" + Math.round(rate).toLocaleString("en-US") + "/sqm", rate: Math.round(rate) };
    while (types.some((y) => y.id === t!.id)) t.id += "x";
    types.push(t);
  }
  return t.id;
}

export function plan(rows: string[][], ctx: Ctx) {
  const H = rows[0].map(nk), ix = (n: string) => H.indexOf(n);
  const C: Record<string, number> = {
    st: ix("accountstatus"), nm: ix("clientname"), ph: ix("phonenumber"), pj: ix("project"), bk: ix("block"),
    lt: ix("lot"), ar: ix("area"), pr: ix("pricepersqm"), tm: ix("terms"), dp: ix("dp"), dd: ix("downpaymentdate"),
    dc: ix("dateofcontract"), rd: ix("reservationfeedate"), pd: ix("partialdpstartdate"), ag: ix("salesagent"),
  };
  const need = ["st", "nm", "pj", "bk", "lt"].filter((k) => C[k] < 0);
  if (need.length) throw new Error("Columns not found in the sheet tab: " + need.join(", ") + ". Check the tab name.");
  const g = (r: string[], k: string) => (C[k] < 0 ? "" : String(r[C[k]] == null ? "" : r[C[k]]).trim());
  const P: Record<string, Patch> = {};
  const S: Stats = { rows: rows.length - 1, noMap: 0, noLot: 0, amb: 0, otherStatus: 0, dup: 0, used: 0, amb_list: [] };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], mid = mapOf(g(r, "pj"));
    if (!g(r, "nm") && !g(r, "bk")) continue;
    if (!mid) { S.noMap++; continue; }
    const f = findKey(ctx.lookup, mid, g(r, "bk"), g(r, "lt"));
    if (f.err || !f.key) {
      if (f.err == "amb") { S.amb++; S.amb_list.push(g(r, "pj") + " " + g(r, "bk") + "-" + g(r, "lt")); } else S.noLot++;
      continue;
    }
    const sn = nk(g(r, "st")), p: Patch = {};
    let stp: string | null = null;
    if (sn == "doas") stp = "D"; else if (sn == "active" || sn == "stoppedpayment") stp = "A"; else S.otherStatus++;
    const term = parseInt(String(num(g(r, "tm"))), 10), area = num(g(r, "ar")), rate = num(g(r, "pr")), dpv = pct(g(r, "dp"));
    if (g(r, "nm")) p.client = tcase(g(r, "nm"));
    const ph = phone(g(r, "ph")); if (ph) p.contact = ph;
    const ag = g(r, "ag").toUpperCase();
    if (ag) p.agent = (ctx.resolveAgent && ctx.resolveAgent(ag)) || ag;
    if (area > 0 && area <= 2000) p.area = area;
    if (rate > 0 && rate < 100000 && area > 0 && area <= 2000) p.type = typeFor(ctx.types, rate);
    if (!isNaN(dpv)) p.dp = dpv;
    if (term > 0) p.term = term;
    const rd = isoOK(g(r, "rd")), dd = isoOK(g(r, "dd")), dc = isoOK(g(r, "dc")), pd = isoOK(g(r, "pd"));
    const s0 = dd && (!rd || dd >= rd) ? dd : dc || pd || "";
    if (s0) p.start = s0;
    if (stp) p.status = term > 0 ? stp : stp == "A" ? "T" : stp;
    if (sn == "stoppedpayment") p._note = "Stopped payment";
    if (P[f.key]) S.dup++;
    P[f.key] = p;
  }
  return { P, S };
}

// ---- diff: desired values vs current lots -> minimal patches -----------------
export function diff(P: Record<string, Patch>, lots: Record<string, Lot>, terms: number[]) {
  const T = new Set<number>(terms);
  const patches: Record<string, Patch> = {};
  let fields = 0, first: string | null = null;
  for (const k in P) {
    const p = P[k], c = lots[k] || {}, patch: Patch = {};
    for (const f in p) {
      if (f == "_note") { if (!c.notes) patch.notes = p._note; continue; }
      if (f == "term") T.add(p.term as number);
      const cur = c[f];
      const same = f == "area" || f == "dp" || f == "term" ? +(cur as number) === +(p[f] as number)
        : String(cur == null ? "" : cur) === String(p[f]);
      if (!same) patch[f] = p[f];
    }
    if (p.status == "T" && c.status == "T" && "term" in patch) delete patch.term;
    const n = Object.keys(patch).length;
    if (!n) continue;
    patches[k] = patch; fields += n; first = first || k;
  }
  const newTerms = [...T].sort((a, b) => a - b);
  const termsChanged = newTerms.length !== terms.length || newTerms.some((v, i) => v !== [...terms].sort((a, b) => a - b)[i]);
  return { patches, fields, first, newTerms, termsChanged };
}

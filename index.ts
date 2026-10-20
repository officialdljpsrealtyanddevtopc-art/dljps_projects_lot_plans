// Supabase Edge Function: sheet-sync
// Pulls the CLIENTS (and optional TEAM) tab of the Google Sheet and merges it into public.lots.
// Same rules as the old in-browser sync, but runs on a schedule and needs no open browser tab.
//
// Auth (verify_jwt is OFF for this function; it checks itself):
//   - header  x-cron-secret: <SYNC_CRON_SECRET>      -> scheduled runs (pg_cron)
//   - header  Authorization: Bearer <staff user JWT>  -> "Sync now" from the app (user must be in public.staff)
// Query:  ?dry_run=1  -> compute and report, write nothing.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { diff, makeResolver, parseCSV, plan, rowsToRoster, buildIdx, type LotType, type Lot } from "./core.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("SYNC_CRON_SECRET") ?? "";
const DEFT: LotType[] = [{ id: "i", name: "Inner", rate: 7000 }, { id: "c", name: "Corner", rate: 7500 }];

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" } });

async function fetchTab(sheetId: string, tab: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { headers: { "Cache-Control": "no-store" } });
  if (!res.ok) throw new Error(`Google returned ${res.status}. Share the sheet as "Anyone with the link – Viewer".`);
  const txt = await res.text();
  if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('Google asked for sign-in. Share the sheet as "Anyone with the link – Viewer".');
  const rows = parseCSV(txt);
  if (rows.length < 2) throw new Error(`The "${tab}" tab is empty or the tab name is wrong.`);
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

  // ---- who is calling? ----
  let by = "";
  const secret = req.headers.get("x-cron-secret");
  if (CRON_SECRET && secret && secret === CRON_SECRET) by = "Sheet sync (scheduled)";
  else {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);
    const { data: u, error } = await createClient(URL_, ANON).auth.getUser(jwt);
    if (error || !u?.user) return json({ error: "unauthorized" }, 401);
    const { data: st } = await db.from("staff").select("name").eq("user_id", u.user.id).maybeSingle();
    if (!st) return json({ error: "forbidden" }, 403);
    by = "Sheet sync (" + (st.name || u.user.email || "staff") + ")";
  }
  const dry = new URL(req.url).searchParams.get("dry_run") === "1";

  const started = new Date().toISOString();
  const log = async (ok: boolean, stats: unknown, error?: string) => {
    if (dry) return;
    await db.from("sync_runs").insert({ started_at: started, ok, stats, error: error ?? null, triggered_by: by });
  };

  try {
    const { data: cfg } = await db.from("sync_config").select("*").eq("id", 1).maybeSingle();
    if (!cfg?.sheet_id) throw new Error("sync_config.sheet_id is empty. Paste the Google Sheet ID into the sync_config table.");
    if (cfg.enabled === false && by.includes("scheduled")) return json({ skipped: "disabled" });

    const rows = await fetchTab(cfg.sheet_id, cfg.clients_tab || "CLIENTS");

    // optional roster (agent name normalisation). Failure here must not stop the lot sync.
    let resolveAgent: ((a: string) => string) | undefined;
    let rosterNote = "";
    try {
      const t = await fetchTab(cfg.sheet_id, cfg.team_tab || "TEAM");
      const roster = rowsToRoster(t);
      resolveAgent = makeResolver(roster);
      rosterNote = `${roster.length} people`;
    } catch (e) { rosterNote = "not used: " + (e as Error).message; }

    const [{ data: idxRows, error: e1 }, { data: lotRows, error: e2 }, { data: setRow, error: e3 }] = await Promise.all([
      db.from("lot_index").select("map_id,block,lot,key"),
      db.from("lots").select("key,data"),
      db.from("settings").select("data").eq("id", 1).maybeSingle(),
    ]);
    if (e1 || e2 || e3) throw new Error((e1 || e2 || e3)!.message);
    if (!idxRows?.length) throw new Error("lot_index is empty. Run the lot_index INSERT part of 03_sheet_sync.sql.");

    const lots: Record<string, Lot> = {};
    for (const r of lotRows ?? []) lots[r.key] = r.data as Lot;
    const settings = (setRow?.data ?? {}) as { types?: LotType[]; terms?: number[] };
    const types: LotType[] = Array.isArray(settings.types) && settings.types.length ? settings.types.map((t) => ({ ...t })) : DEFT.map((t) => ({ ...t }));
    const terms: number[] = Array.isArray(settings.terms) && settings.terms.length ? settings.terms : [12, 24, 36];
    const typesBefore = JSON.stringify(types);

    const { P, S } = plan(rows, { lookup: buildIdx(idxRows), types, resolveAgent });
    const d = diff(P, lots, terms);
    const typesChanged = JSON.stringify(types) !== typesBefore;

    // Safety valve: a sheet that suddenly matches far fewer lots than before is probably broken/truncated.
    const { data: prev } = await db.from("sync_runs").select("stats").eq("ok", true).order("started_at", { ascending: false }).limit(1).maybeSingle();
    const prevUsed = Number((prev?.stats as { used?: number } | null)?.used ?? 0);
    S.used = Object.keys(P).length;
    if (prevUsed >= 20 && S.used < prevUsed * 0.5)
      throw new Error(`Refusing to apply: sheet matched ${S.used} lots, last good run matched ${prevUsed}. Check the sheet, then re-run.`);

    const summary = { ...S, lots: Object.keys(d.patches).length, fields: d.fields, roster: rosterNote, dry_run: dry };
    if (!dry && (summary.lots || typesChanged || d.termsChanged)) {
      const { error } = await db.rpc("apply_sheet_sync", {
        p_patches: d.patches,
        p_types: typesChanged ? types : null,
        p_terms: d.termsChanged ? d.newTerms : null,
        p_first: d.first,
        p_count: summary.lots,
        p_by: by,
      });
      if (error) throw new Error(error.message);
    }
    await log(true, summary);
    return json({ ok: true, ...summary, sample: dry ? Object.entries(d.patches).slice(0, 5) : undefined });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await log(false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});

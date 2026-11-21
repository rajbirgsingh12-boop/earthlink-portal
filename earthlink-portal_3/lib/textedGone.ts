// A crew picture deleted from a job's Documents comes off the texted batch
// that brought it too, so the Schedule card counts what is left and its
// "Wrong job?" moves only what is there (/api/texted-photos "gone"). Best
// effort, after the picture is already gone: nothing waits on it.
import { sb } from "@/lib/supabase";

// a picture the crew texted in, by its name: "before_2026-11-20_143012_jose_x7k2.jpg"
const TEXTED = /^(before|after|noaccess)_\d{4}-\d{2}-\d{2}_\d{6}_/i;

export function goneFromTexted(job: { pact_job_id?: string; release_id?: string }, paths: string[]): void {
  const crew = paths.filter((p) => TEXTED.test((p || "").split("/").pop() || ""));
  if (!crew.length) return;
  void (async () => {
    const token = (await sb().auth.getSession()).data.session?.access_token || "";
    if (!token) return;
    await fetch("/api/texted-photos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "gone", ...job, paths: crew }),
    });
  })().catch(() => {});
}

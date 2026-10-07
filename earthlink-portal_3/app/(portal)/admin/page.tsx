"use client";
// Users & roles moved into Settings. Old links and bookmarks land there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminMoved() {
  const router = useRouter();
  useEffect(() => { router.replace("/settings"); }, [router]);
  return <div role="status" className="p-4 text-sm text-inksoft">This page moved to Settings › Users &amp; roles.</div>;
}

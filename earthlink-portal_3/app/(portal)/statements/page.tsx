"use client";
// Invoices & Statements grew into the Invoice Package tab. Old links land there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StatementsMoved() {
  const router = useRouter();
  useEffect(() => { router.replace("/package"); }, [router]);
  return <div role="status" className="p-4 text-sm text-inksoft">Taking you to Invoice Package…</div>;
}

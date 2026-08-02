"use client";
// Invoices & Statements grew into the Invoice Package tab — old links land there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StatementsMoved() {
  const router = useRouter();
  useEffect(() => { router.replace("/package"); }, [router]);
  return <div className="p-4 text-sm text-inksoft">This page moved to Invoice Package…</div>;
}

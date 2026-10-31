"use client";

import { useParams } from "next/navigation";
import LoadingSkeleton from "@/components/LoadingSkeleton";

export default function Loading() {
  const { chain } = useParams<{ chain: string }>();
  return <LoadingSkeleton chain={chain} />;
}

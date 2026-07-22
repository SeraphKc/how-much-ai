"use client";

import { useEffect, useId, useRef, useState } from "react";
import { severityColor, timeUntil } from "@/lib/format";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function useAnimatedNumber(value: number, reducedMotion: boolean, duration = 700): number {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    if (reducedMotion) {
      prevRef.current = value;
      setDisplay(value);
      return;
    }

    const from = prevRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    let raf: number;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        prevRef.current = value;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      prevRef.current = value;
    };
  }, [value, reducedMotion, duration]);

  return display;
}

interface UsageBarProps {
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: string;
  now: number;
}

export function UsageBar({ label, percent, resetsAt, severity, now }: UsageBarProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const normalizedPercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const display = useAnimatedNumber(normalizedPercent, reducedMotion);
  const color = severityColor(normalizedPercent, severity);
  const reset = timeUntil(resetsAt, now);
  const critical = severity === "critical" || normalizedPercent >= 90;
  const elevated = !critical && (severity === "warning" || severity === "elevated" || normalizedPercent >= 70);
  const labelId = useId();
  const roundedPercent = Math.round(normalizedPercent);

  return (
    <div>
      <div className="grid gap-y-1 xs:grid-cols-[minmax(0,1fr)_auto] xs:items-baseline xs:gap-x-3 xs:gap-y-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span id={labelId} title={label} className="min-w-0 truncate text-[13px] text-muted">
            {label}
          </span>
          {critical && (
            <span className="shrink-0 rounded-full bg-danger/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[#ea7b74]">
              near limit
            </span>
          )}
          {elevated && (
            <span className="shrink-0 rounded-full bg-amber/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[#e3b56e]">
              high
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-baseline justify-between gap-2 xs:shrink-0 xs:justify-end">
          {reset && <span className="text-[11px] text-faint">{reset}</span>}
          <span className="ml-auto w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-ivory">
            {Math.round(display)}%
          </span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercent}
        aria-valuetext={`${roundedPercent}% used${reset ? `, ${reset}` : ""}`}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-track"
      >
        <div
          className="bar-fill h-full rounded-full"
          style={{ width: mounted || reducedMotion ? `${normalizedPercent}%` : "0%", backgroundColor: color }}
        />
      </div>
    </div>
  );
}

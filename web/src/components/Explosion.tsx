import { useEffect, useRef, type CSSProperties } from "react";

export interface ExplosionProps {
  /** Burst size in px (flash diameter; particles fly about 0.5x this far). */
  size?: number;
  particles?: number;
  durationMs?: number;
  onDone?: () => void;
}

/** Evenly spaced, deterministic particle offsets (no randomness, so it tests and replays the same). */
export function particleVectors(count: number, radius: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    const r = radius * (i % 2 === 0 ? 1 : 0.65);
    return { dx: Math.round(Math.cos(angle) * r), dy: Math.round(Math.sin(angle) * r) };
  });
}

const STILL_MS = 250;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Decorative explosion. Place inside a positioned parent; it bursts from the parent's top-left
 * origin, so wrap it in an element you position at the blast point.
 * Reduced motion: a short fade, no moving parts.
 */
export function Explosion({ size = 160, particles = 14, durationMs = 700, onDone }: ExplosionProps) {
  const reduce = useRef(prefersReducedMotion()).current;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const t = setTimeout(() => done.current?.(), reduce ? STILL_MS : durationMs);
    return () => clearTimeout(t);
  }, [reduce, durationMs]);

  const style = { "--boom-size": `${size}px`, "--boom-ms": `${durationMs}ms` } as CSSProperties;
  return (
    <span className={reduce ? "explosion explosion--still" : "explosion"} style={style} aria-hidden="true">
      <span className="explosion__flash" />
      {!reduce &&
        particleVectors(particles, size / 2).map((v, i) => (
          <span
            key={i}
            className="explosion__particle"
            style={{ "--dx": `${v.dx}px`, "--dy": `${v.dy}px` } as CSSProperties}
          />
        ))}
    </span>
  );
}

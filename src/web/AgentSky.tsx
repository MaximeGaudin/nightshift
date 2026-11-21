import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/** A signal walking the constellation: from one star to a neighbour, then on to the next. */
interface Signal {
  from: number;
  to: number;
  /** Progress along the current link, 0..1. */
  t: number;
  /** Pixels per second. */
  speed: number;
  hops: number;
}

/** Two stars closer than this are linked. */
const LINK = 150;
/** One star per this many square pixels, within the bounds below. */
const AREA_PER_STAR = 21_000;
const MIN_STARS = 12;
const MAX_STARS = 80;
const FRAME_MS = 1000 / 30;

/** Signals on screen: a quiet board keeps a couple alive, each working agent adds more. */
export function signalCount(activity: number): number {
  return Math.min(14, 2 + Math.max(0, activity) * 3);
}

export function starCount(width: number, height: number): number {
  return Math.max(MIN_STARS, Math.min(MAX_STARS, Math.round((width * height) / AREA_PER_STAR)));
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function makeStar(width: number, height: number): Star {
  const angle = rand(0, Math.PI * 2);
  const speed = rand(2, 7);
  return { x: rand(0, width), y: rand(0, height), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: rand(0.8, 1.7) };
}

/**
 * Background of the board panel: a slow constellation whose links carry signals from star to star, like agents handing work over.
 * Decorative only: hidden from assistive tech, never takes pointer events, and stays still under reduced motion.
 */
export function AgentSky({ activity }: { activity: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wanted = useRef(activity);
  wanted.current = activity;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    let color = "#8f99ff";
    let strength = 1;
    const readTheme = () => {
      color = getComputedStyle(canvas).getPropertyValue("--glow").trim() || color;
      strength = scheme.matches ? 1 : 0.75;
    };
    readTheme();

    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let signals: Signal[] = [];

    const dist = (a: Star, b: Star) => Math.hypot(a.x - b.x, a.y - b.y);
    const neighbours = (i: number, except = -1) => {
      const origin = stars[i];
      const out: number[] = [];
      if (!origin) return out;
      for (let j = 0; j < stars.length; j++) {
        const other = stars[j];
        if (j !== i && j !== except && other && dist(origin, other) < LINK) out.push(j);
      }
      return out;
    };
    const pick = (list: number[]) => list[Math.floor(Math.random() * list.length)];

    const spawn = () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const from = Math.floor(Math.random() * stars.length);
        const to = pick(neighbours(from));
        if (to === undefined) continue;
        signals.push({ from, to, t: 0, speed: rand(55, 110), hops: Math.floor(rand(2, 6)) });
        return;
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = starCount(width, height);
      if (stars.length > count) {
        stars = stars.slice(0, count);
        signals = [];
      }
      while (stars.length < count) stars.push(makeStar(width, height));
      for (const s of stars) {
        s.x = Math.min(s.x, width);
        s.y = Math.min(s.y, height);
      }
      draw();
    };

    const step = (dt: number) => {
      for (const s of stars) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.x < 0 || s.x > width) s.vx = -s.vx;
        if (s.y < 0 || s.y > height) s.vy = -s.vy;
        s.x = Math.max(0, Math.min(width, s.x));
        s.y = Math.max(0, Math.min(height, s.y));
      }
      signals = signals.filter((sig) => {
        const a = stars[sig.from];
        const b = stars[sig.to];
        if (!a || !b) return false;
        const d = dist(a, b);
        // The two stars drifted apart: the link is gone, and the signal with it.
        if (d > LINK * 1.15) return false;
        sig.t += (sig.speed * dt) / Math.max(d, 1);
        if (sig.t < 1) return true;
        const next = pick(neighbours(sig.to, sig.from));
        if (next === undefined || --sig.hops <= 0) return false;
        sig.from = sig.to;
        sig.to = next;
        sig.t = 0;
        return true;
      });
      const target = signalCount(wanted.current);
      if (signals.length < target && Math.random() < 0.08 + 0.04 * wanted.current) spawn();
    };

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      for (let i = 0; i < stars.length; i++) {
        const a = stars[i];
        if (!a) continue;
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j];
          if (!b) continue;
          const d = dist(a, b);
          if (d >= LINK) continue;
          ctx.globalAlpha = (1 - d / LINK) * 0.13 * strength;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.4 * strength;
      for (const s of stars) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const sig of signals) {
        const a = stars[sig.from];
        const b = stars[sig.to];
        if (!a || !b) continue;
        const x = a.x + (b.x - a.x) * sig.t;
        const y = a.y + (b.y - a.y) * sig.t;
        const tail = Math.max(0, sig.t - 0.35);
        const tx = a.x + (b.x - a.x) * tail;
        const ty = a.y + (b.y - a.y) * tail;
        const trail = ctx.createLinearGradient(tx, ty, x, y);
        trail.addColorStop(0, "transparent");
        trail.addColorStop(1, color);
        ctx.globalAlpha = 0.7 * strength;
        ctx.strokeStyle = trail;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 0.95 * strength;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    }

    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      // A tab coming back from the background would otherwise jump by the whole time away.
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
      last = now;
      step(dt);
      draw();
    };
    const start = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (reduced.matches || document.hidden) {
        signals = [];
        draw();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const onTheme = () => {
      readTheme();
      draw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    start();
    reduced.addEventListener("change", start);
    scheme.addEventListener("change", onTheme);
    document.addEventListener("visibilitychange", start);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reduced.removeEventListener("change", start);
      scheme.removeEventListener("change", onTheme);
      document.removeEventListener("visibilitychange", start);
    };
  }, []);

  return (
    <div className="agent-sky" aria-hidden="true">
      <canvas ref={ref} />
    </div>
  );
}

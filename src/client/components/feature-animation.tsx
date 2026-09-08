import { useEffect, useRef, useState } from "react";

// Kept in sync with the 4,800 ms timelines in scripts/artwork/*.py.
const DURATION_MS = 4_800;

export function FeatureAnimation({ illustration, animation, label }: {
  illustration: string;
  animation: string;
  label: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [run, setRun] = useState(0);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5)) return;
      observer.disconnect();
      if (!motion.matches) setRun(value => value || 1);
    }, { threshold: .5 });
    if (button.current) observer.observe(button.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!run) return;
    const controller = new AbortController();
    let url: string | undefined;
    // A fresh object URL restarts cached WebP animations reliably on replay.
    void fetch(animation, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Animation unavailable");
        return response.blob();
      })
      .then(blob => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setSource(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSource(null);
      });
    return () => {
      controller.abort();
      clearTimeout(timer.current);
      if (url) URL.revokeObjectURL(url);
    };
  }, [animation, run]);

  return (
    <button
      ref={button}
      type="button"
      className="marketing-feature__illustration marketing-animation"
      aria-label={`${source ? "正在演示" : run ? "重播" : "播放演示"}：${label}`}
      onClick={() => { if (!source) setRun(value => value + 1); }}
    >
      <img
        src={source ?? illustration}
        alt={label}
        width={768}
        height={512}
        loading="lazy"
        decoding="async"
        onLoad={() => {
          if (!source) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setSource(null), DURATION_MS);
        }}
        onError={() => { if (source) setSource(null); }}
      />
    </button>
  );
}

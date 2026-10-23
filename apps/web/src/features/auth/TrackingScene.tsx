import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/** Route the vehicle drives (also drawn as the road). */
const ROUTE = 'M30 210 C 90 210, 95 150, 150 145 S 215 95, 265 100 S 330 60, 380 55';
const LOOP_S = 9;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Decorative live-tracking scene for the sign-in pages: street grid, a route drawing itself, a vehicle driving it
 * and pinging, a destination pin with radar rings and a geofence. Pure SVG + CSS (no libraries); still with
 * prefers-reduced-motion. Colours come from currentColor (roads) and the amber accent (vehicle).
 */
export function TrackingScene({ className, compact = false }: { className?: string; compact?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const animate = !reduced;
  return (
    <svg viewBox={compact ? '0 20 410 220' : '0 0 410 260'} className={cn('vt-scene', !animate && 'vt-still', className)} role="img" aria-hidden focusable="false">
      {/* Street grid */}
      <g stroke="currentColor" strokeOpacity="0.12" strokeWidth="1">
        {[40, 90, 140, 190, 240].map((y) => (
          <line key={`h${y}`} x1="0" x2="410" y1={y} y2={y} />
        ))}
        {[40, 100, 160, 220, 280, 340, 400].map((x) => (
          <line key={`v${x}`} y1="0" y2="260" x1={x} x2={x} />
        ))}
      </g>
      {/* Geofence */}
      <circle cx="150" cy="145" r="34" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.35" strokeDasharray="4 5" className="vt-spin" />
      {/* Road + route trace */}
      <path d={ROUTE} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="10" strokeLinecap="round" />
      <path d={ROUTE} fill="none" stroke="var(--sidebar-primary, #ffb443)" strokeWidth="3" strokeLinecap="round" className="vt-trace" pathLength={100} style={{ animationDuration: `${LOOP_S}s` }} />
      {/* Start */}
      <circle cx="30" cy="210" r="5" fill="currentColor" fillOpacity="0.6" />
      {/* Destination pin with radar rings */}
      <g transform="translate(380 55)">
        <circle r="8" fill="none" stroke="var(--sidebar-primary, #ffb443)" strokeWidth="2" className="vt-ping" />
        <circle r="8" fill="none" stroke="var(--sidebar-primary, #ffb443)" strokeWidth="2" className="vt-ping" style={{ animationDelay: '1s' }} />
        <path d="M0 -22 C -9 -22 -14 -15 -14 -9 C -14 0 0 10 0 10 C 0 10 14 0 14 -9 C 14 -15 9 -22 0 -22 Z" fill="var(--sidebar-primary, #ffb443)" />
        <circle cy="-10" r="4.5" fill="var(--sidebar, #0b3b36)" />
      </g>
      {/* Vehicle */}
      <g>
        <g>
          <circle r="16" fill="var(--sidebar-primary, #ffb443)" fillOpacity="0.18" className="vt-ping" style={{ animationDuration: '1.6s' }} />
          <circle r="9" fill="var(--sidebar-primary, #ffb443)" stroke="#fff" strokeWidth="2.5" />
          <path d="M-3.5 3 L0 -4.5 L3.5 3 L0 1.2 Z" fill="#fff" transform="rotate(90)" />
        </g>
        {animate ? (
          <animateMotion dur={`${LOOP_S}s`} repeatCount="indefinite" rotate="auto" keyPoints="0;1;1" keyTimes="0;0.85;1" calcMode="linear" path={ROUTE} />
        ) : (
          <animateMotion dur="0.01s" fill="freeze" rotate="auto" keyPoints="0.55;0.55" keyTimes="0;1" calcMode="linear" path={ROUTE} />
        )}
      </g>
    </svg>
  );
}

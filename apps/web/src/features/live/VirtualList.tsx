import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Fixed-row-height windowed list: renders only the rows in view (plus overscan). */
export function VirtualList<T>({
  items,
  rowHeight,
  getKey,
  renderRow,
  overscan = 8,
  className,
  label,
}: {
  items: readonly T[];
  rowHeight: number;
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  overscan?: number;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  return (
    <div ref={ref} role="list" aria-label={label} className={cn('relative overflow-y-auto', className)} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * rowHeight }} className="relative">
        {items.slice(start, end).map((item, i) => (
          <div key={getKey(item)} role="listitem" className="absolute inset-x-0" style={{ top: (start + i) * rowHeight, height: rowHeight }}>
            {renderRow(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

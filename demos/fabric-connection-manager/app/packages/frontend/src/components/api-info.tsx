import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export function ApiInfo({ label, description, endpoint = '/v1/admin/connections' }: {
  label: string;
  description: string;
  endpoint?: string;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;

  useEffect(() => {
    if (!pinned) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setPinned(false);
        setHovered(false);
      }
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [pinned]);

  return (
    <div ref={container} className="relative shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPinned(false);
          setHovered(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPinned(false);
          setHovered(false);
        }
      }}>
      <button type="button" aria-label={`API information for ${label}`}
        aria-expanded={open} aria-describedby={open ? id : undefined}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
        onFocus={() => setHovered(true)}
        onClick={() => {
          setPinned(!pinned);
          setHovered(false);
        }}>
        <Info size={16} aria-hidden="true" />
      </button>
      {open && <div id={id} role="tooltip"
        className="absolute right-0 top-full z-20 w-56 max-w-[calc(100vw-3rem)] rounded-lg border border-border bg-popover p-300 text-left text-200 text-popover-foreground shadow-lg">
        <p className="font-semibold">Collection source: Fabric REST API</p>
        <code className="mt-200 block break-all font-monospace">GET https://api.fabric.microsoft.com{endpoint}</code>
        <p className="mt-200 leading-300">{description}</p>
        <p className="mt-200 text-muted-foreground">Collected by the CollectConnectionInventory notebook. This dashboard reads a published Lakehouse snapshot through its read-only connector.</p>
      </div>}
    </div>
  );
}

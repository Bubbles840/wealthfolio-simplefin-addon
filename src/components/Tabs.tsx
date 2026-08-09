import React, { useRef } from 'react';

export type TabId = 'overview' | 'notifications' | 'advanced';

/**
 * A real tablist, not styled buttons: role/aria-selected/roving tabindex and
 * arrow-key movement per the WAI-ARIA tabs pattern. Panels are the CALLER's —
 * each button points at `sfin-panel-<id>` so the caller's `role="tabpanel"`
 * container wires up by convention rather than by prop-drilling children here.
 */
export function TabBar({ tabs, active, onChange }: {
  tabs: Array<{ id: TabId; label: string }>;
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const tabRefs = useRef<Map<TabId, HTMLButtonElement>>(new Map());

  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === active);
    const nextId = tabs[(i + delta + tabs.length) % tabs.length].id;
    onChange(nextId);
    // Focus the target tab after onChange, since parent owns active state
    // and re-render is async. Target the element by id directly.
    setTimeout(() => {
      const btn = document.getElementById(`sfin-tab-${nextId}`) as HTMLButtonElement;
      if (btn) btn.focus();
    }, 0);
  };

  return (
    <div className="sfin-tabbar" role="tablist" aria-label="SimpleFin Sync sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`sfin-tab-${t.id}`}
          ref={(el) => {
            if (el) {
              tabRefs.current.set(t.id, el);
            } else {
              tabRefs.current.delete(t.id);
            }
          }}
          aria-selected={t.id === active}
          aria-controls={`sfin-panel-${t.id}`}
          tabIndex={t.id === active ? 0 : -1}
          className={t.id === active ? 'sfin-tab sfin-tab--active' : 'sfin-tab'}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
            if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

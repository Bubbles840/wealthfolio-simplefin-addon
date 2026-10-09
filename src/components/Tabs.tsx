import React, { useRef } from 'react';

export type TabId = 'home' | 'reports' | 'settings';

/**
 * A stored `ui_state.activeTab` from any version, as one of today's tabs.
 *
 * 1.56 and earlier had five tabs (budget, reports, overview, notifications,
 * advanced); 1.57 folded them into three. The stored value is an unvalidated
 * blob, so anything unrecognised — a hand-edited secret, a tab from a newer
 * build after a downgrade — lands on Home. A blank page with no way back is far
 * worse than the wrong tab.
 */
export function resolveStoredTab(raw: unknown): TabId {
  switch (raw) {
    case 'reports': return 'reports';
    case 'settings': case 'notifications': case 'advanced': return 'settings';
    default: return 'home';
  }
}

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
    // Focus the target tab synchronously from the ref Map. No setTimeout needed:
    // tabindex="-1" means not in sequential tab order but still programmatically
    // focusable. The button is already mounted in DOM; .focus() succeeds immediately
    // without waiting for React's re-render to move the roving tabindex.
    tabRefs.current.get(nextId)?.focus();
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

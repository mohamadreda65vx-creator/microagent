import clsx from 'clsx';

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ key: T; label: string; badge?: string | number }>; value: T; onChange: (k: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-mist-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={clsx(
            '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.key ? 'border-burgundy-700 text-burgundy-800' : 'border-transparent text-mist-500 hover:text-mist-800',
          )}
        >
          {t.label}
          {t.badge !== undefined ? <span className="rounded-full bg-burgundy-50 px-1.5 text-[11px] text-burgundy-700">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

import clsx from 'clsx';
import { Loader2, type LucideIcon } from 'lucide-react';
import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from '../../lib/api';

/* ───────── Button ───────── */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'light';
const variants: Record<Variant, string> = {
  primary: 'bg-burgundy-700 text-white shadow-sm hover:bg-burgundy-800 active:bg-burgundy-900',
  secondary: 'bg-white text-mist-800 border border-mist-300 hover:bg-mist-50 hover:border-mist-400',
  ghost: 'text-mist-700 hover:bg-mist-100',
  danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50',
  light: 'bg-white text-burgundy-900 hover:bg-burgundy-50',
};
const sizes = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-[15px] gap-2' };

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof sizes;
  loading?: boolean;
  icon?: LucideIcon;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon: Icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-xl font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
});

/* ───────── Form fields ───────── */
const fieldBase =
  'block w-full rounded-xl border bg-white px-3.5 text-sm text-mist-900 placeholder:text-mist-400 transition-colors focus:border-burgundy-500 focus:outline-none focus:ring-4 focus:ring-burgundy-100 disabled:bg-mist-50 disabled:text-mist-500';

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  action?: ReactNode;
}
function FieldShell({ label, hint, error, children, action }: FieldShellProps) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-[13px] font-medium text-mist-700">
          {label}
        </label>
        {action}
      </div>
      {children({ id, describedBy, invalid: !!error })}
      {error ? (
        <p id={`${id}-err`} className="mt-1.5 text-[13px] text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-mist-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  action?: ReactNode;
}
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ label, hint, error, action, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error} action={action}>
      {({ id, describedBy, invalid }) => (
        <input
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={clsx(fieldBase, 'h-11', invalid ? 'border-red-400' : 'border-mist-300', className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
}
export function TextAreaField({ label, hint, error, className, ...rest }: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          rows={4}
          className={clsx(fieldBase, 'py-2.5', invalid ? 'border-red-400' : 'border-mist-300', className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
}
export function SelectField({ label, error, className, children, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} error={error}>
      {({ id, describedBy, invalid }) => (
        <select id={id} aria-describedby={describedBy} className={clsx(fieldBase, 'h-11', invalid ? 'border-red-400' : 'border-mist-300', className)} {...rest}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

/* ───────── Surface helpers ───────── */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-2xl border border-mist-200 bg-white shadow-soft', className)}>{children}</div>;
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'burgundy' | 'amber' | 'red'; children: ReactNode }) {
  const tones = {
    gray: 'bg-mist-100 text-mist-700 ring-mist-200',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    burgundy: 'bg-burgundy-50 text-burgundy-700 ring-burgundy-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
  };
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone])}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton rounded-lg', className)} aria-hidden="true" />;
}

/* ───────── Alerts & states ───────── */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
      {message}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-3 rounded-full bg-burgundy-100/70 blur-xl" aria-hidden="true" />
        <div className="relative grid size-14 place-items-center rounded-2xl border border-burgundy-100 bg-white text-burgundy-600 shadow-soft">
          <Icon className="size-6" strokeWidth={1.6} />
        </div>
      </div>
      <h3 className="font-display text-lg font-semibold text-mist-900">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-pretty text-mist-500">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <h3 className="font-display text-lg font-semibold text-mist-900">We couldn’t load this</h3>
      <p className="mt-1.5 max-w-sm text-sm text-mist-500">{error instanceof Error ? error.message : 'Please try again.'}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/* ───────── Modal (native <dialog>: focus trap + Esc for free) ───────── */
export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-mist-200 bg-white p-0 shadow-lift"
    >
      {open ? (
        <div className="p-6">
          <h2 className="font-display text-xl font-semibold text-mist-900">{title}</h2>
          {description ? <p className="mt-1 text-sm text-mist-500">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

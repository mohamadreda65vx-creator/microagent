import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AnimatedAgent } from '../../components/brand/AnimatedAgent';
import { Logo } from '../../components/brand/Logo';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <div className="flex flex-col px-5 py-8 sm:px-10">
        <Link to="/" aria-label="MicroAgent home" className="w-fit">
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <motion.div initial={reduce ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-[400px]">
            <h1 className="text-3xl font-semibold text-burgundy-950">{title}</h1>
            {subtitle ? <p className="mt-2 text-[15px] text-mist-600">{subtitle}</p> : null}
            <div className="mt-8">{children}</div>
            {footer ? <div className="mt-6 text-center text-sm text-mist-600">{footer}</div> : null}
          </motion.div>
        </div>
      </div>
      <aside className="relative hidden overflow-hidden bg-burgundy-950 lg:block" aria-hidden="true">
        <div className="absolute -top-32 -left-24 size-[420px] rounded-full bg-burgundy-700/50 blur-3xl" />
        <div className="absolute -right-24 -bottom-24 size-[380px] rounded-full bg-burgundy-600/30 blur-3xl" />
        <div className="relative flex h-full flex-col items-center justify-center px-12 text-center">
          <AnimatedAgent className="w-72" />
          <p className="mt-8 font-display text-2xl font-semibold text-white">Your next hire never sleeps.</p>
          <p className="mt-2 max-w-xs text-sm text-burgundy-100/80">Create AI employees, teach them your business and manage them from one workspace.</p>
        </div>
      </aside>
    </div>
  );
}

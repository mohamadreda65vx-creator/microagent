import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ArrowRight, BookOpen, Check, GraduationCap, LineChart, MessageSquare, Radio, Sparkles, Users, Workflow } from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { AnimatedAgent } from '../components/brand/AnimatedAgent';
import { Logo } from '../components/brand/Logo';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/primitives';

const chips = [
  { icon: MessageSquare, label: 'Answers customers', pos: 'left-0 top-[14%]', delay: 0 },
  { icon: BookOpen, label: 'Knows your business', pos: 'right-0 top-[8%]', delay: 0.8 },
  { icon: Radio, label: 'Every channel', pos: 'left-[2%] bottom-[20%]', delay: 1.6 },
  { icon: Sparkles, label: 'Learns from you', pos: 'right-[2%] bottom-[16%]', delay: 2.4 },
];

const features = [
  { icon: Users, title: 'AI Employees', text: 'Create employees with a role, a personality and a job: support, sales, bookings. Each one works for your business only.' },
  { icon: BookOpen, title: 'Business Knowledge', text: 'Teach them your products, prices and policies once. They answer from what you told them, not from guesses.' },
  { icon: Radio, title: 'Channels', text: 'Meet customers where they already are. One workspace for every conversation.' },
  { icon: GraduationCap, title: 'Teach & Correct', text: 'See a wrong answer? Correct it once and your employee does better next time.' },
  { icon: Workflow, title: 'Workflow Builder', text: 'Connect your AI employees to the tools and steps your team already uses.' },
  { icon: LineChart, title: 'Performance', text: 'Track what each employee handles, how fast, and where they need help.' },
];

const steps = [
  { n: '01', title: 'Create your workspace', text: 'Sign up in a minute. Your business gets its own private space: your data, your team, your settings.' },
  { n: '02', title: 'Hire your first AI employee', text: 'Give it a name, a job title and a description of what it should do.' },
  { n: '03', title: 'Teach, correct, improve', text: 'Add your business knowledge, review conversations and correct answers as you go.' },
];

export default function Landing() {
  const reduce = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const agentY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : 90]);
  const glowScale = useTransform(scrollYProgress, [0, 1], [1, reduce ? 1 : 1.4]);

  return (
    <div className="overflow-x-clip bg-white">
      {/* ───── Nav ───── */}
      <header className="sticky top-0 z-40 border-b border-mist-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" aria-label="MicroAgent home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-8 text-sm font-medium text-mist-600 md:flex" aria-label="Sections">
            <a href="#features" className="hover:text-burgundy-700">Features</a>
            <a href="#how" className="hover:text-burgundy-700">How it works</a>
            <a href="#trust" className="hover:text-burgundy-700">Security</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="rounded-xl px-3.5 py-2 text-sm font-medium text-mist-700 hover:bg-mist-100">Login</Link>
            <Link to="/signup" className="hidden sm:block">
              <Button size="md">Create Your AI Agent</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* ───── Hero ───── */}
      <section ref={heroRef} className="relative">
        <div className="grid-fade pointer-events-none absolute inset-0" aria-hidden="true" />
        <motion.div style={{ scale: glowScale }} className="pointer-events-none absolute top-10 right-[-10%] size-[560px] rounded-full bg-burgundy-200/60 blur-3xl" aria-hidden="true" />

        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pt-14 pb-20 lg:grid-cols-[1.05fr_1fr] lg:pt-20 lg:pb-28">
          <div>
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 rounded-full border border-burgundy-200 bg-burgundy-50 px-3.5 py-1.5 text-[13px] font-medium text-burgundy-700"
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-burgundy-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-burgundy-600" />
              </span>
              AI employees for real businesses
            </motion.div>

            <motion.h1
              initial={reduce ? false : { opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
              className="mt-6 text-5xl leading-[1.04] font-semibold text-balance text-burgundy-950 sm:text-6xl lg:text-[4.4rem]"
            >
              Hire an AI employee.
              <br />
              <span className="bg-gradient-to-r from-burgundy-600 to-burgundy-800 bg-clip-text text-transparent">Train it like your own.</span>
            </motion.h1>

            <motion.p
              initial={reduce ? false : { opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="mt-6 max-w-xl text-lg text-pretty text-mist-600"
            >
              MicroAgent is the workspace where you create, teach and manage AI employees that talk to your customers, know your business and keep getting better.
            </motion.p>

            <motion.div
              initial={reduce ? false : { opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="mt-9 flex flex-wrap items-center gap-3"
            >
              <Link to="/signup">
                <Button size="lg">
                  Create Your AI Agent <ArrowRight className="size-4" />
                </Button>
              </Link>
              <Link to="/login">
                <Button size="lg" variant="secondary">Login</Button>
              </Link>
            </motion.div>

            <motion.ul
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.5 }}
              className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-mist-500"
            >
              {['Private workspace per business', 'Your team, your roles', 'No credit card to start'].map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check className="size-4 text-burgundy-600" /> {t}
                </li>
              ))}
            </motion.ul>
          </div>

          {/* Animated agent + floating chips */}
          <div className="relative mx-auto aspect-[360/400] w-full max-w-[460px]">
            <div className="absolute inset-[8%] rounded-full border border-dashed border-burgundy-200" aria-hidden="true" />
            <div className="animate-orbit absolute inset-[-2%] rounded-full border border-burgundy-100" aria-hidden="true">
              <span className="absolute top-[12%] left-[10%] size-3 rounded-full bg-burgundy-500" />
              <span className="absolute right-[6%] bottom-[22%] size-2.5 rounded-full bg-burgundy-300" />
            </div>
            <motion.div style={{ y: agentY }} className="absolute inset-0">
              <AnimatedAgent className="size-full drop-shadow-2xl" />
            </motion.div>
            {chips.map(({ icon: Icon, label, pos, delay }) => (
              <motion.div
                key={label}
                className={`absolute ${pos} hidden items-center gap-2 rounded-full border border-mist-200 bg-white/95 py-2 pr-4 pl-2.5 text-[13px] font-medium text-mist-700 shadow-soft backdrop-blur sm:flex`}
                initial={reduce ? false : { opacity: 0, scale: 0.85 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: [0, -8, 0] }}
                transition={{ opacity: { delay: 0.6 + delay / 4 }, scale: { delay: 0.6 + delay / 4 }, y: { duration: 4.5, repeat: Infinity, delay, ease: 'easeInOut' } }}
              >
                <span className="grid size-7 place-items-center rounded-full bg-burgundy-50 text-burgundy-600">
                  <Icon className="size-3.5" />
                </span>
                {label}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── Features ───── */}
      <section id="features" className="border-y border-mist-200 bg-mist-50 py-24">
        <div className="mx-auto max-w-6xl px-5">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold tracking-wide text-burgundy-600 uppercase">The platform</p>
            <h2 className="mt-3 text-4xl font-semibold text-balance text-burgundy-950 sm:text-5xl">Everything to run an AI team, in one place</h2>
            <p className="mt-4 text-lg text-mist-600">From the first employee to a whole team, with the control a real business needs.</p>
          </Reveal>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={(i % 3) * 0.08}>
                <motion.div whileHover={reduce ? undefined : { y: -5 }} transition={{ type: 'spring', stiffness: 300, damping: 22 }} className="group h-full rounded-2xl border border-mist-200 bg-white p-6 shadow-soft transition-shadow hover:shadow-lift">
                  <div className="grid size-11 place-items-center rounded-xl bg-burgundy-50 text-burgundy-700 transition-colors group-hover:bg-burgundy-700 group-hover:text-white">
                    <Icon className="size-5" strokeWidth={1.8} />
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-mist-900">{title}</h3>
                  <p className="mt-2 text-[15px] text-pretty text-mist-600">{text}</p>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ───── How it works ───── */}
      <section id="how" className="py-24">
        <div className="mx-auto max-w-6xl px-5">
          <Reveal className="max-w-2xl">
            <p className="text-sm font-semibold tracking-wide text-burgundy-600 uppercase">How it works</p>
            <h2 className="mt-3 text-4xl font-semibold text-balance text-burgundy-950 sm:text-5xl">From sign-up to your first employee in minutes</h2>
          </Reveal>
          <div className="relative mt-14 grid gap-6 md:grid-cols-3">
            <div className="absolute top-[34px] right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-burgundy-200 via-burgundy-300 to-burgundy-200 md:block" aria-hidden="true" />
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.12}>
                <div className="relative">
                  <div className="relative z-10 grid size-[68px] place-items-center rounded-2xl border border-burgundy-200 bg-white font-display text-xl font-semibold text-burgundy-700 shadow-soft">{s.n}</div>
                  <h3 className="mt-5 text-xl font-semibold text-mist-900">{s.title}</h3>
                  <p className="mt-2 max-w-xs text-[15px] text-mist-600">{s.text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ───── Trust ───── */}
      <section id="trust" className="pb-24">
        <div className="mx-auto max-w-6xl px-5">
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl bg-burgundy-950 px-8 py-14 text-white sm:px-14">
              <div className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-full bg-burgundy-600/40 blur-3xl" aria-hidden="true" />
              <div className="relative grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
                <div>
                  <h2 className="text-3xl font-semibold text-balance sm:text-4xl">Your business data stays yours</h2>
                  <p className="mt-4 max-w-xl text-burgundy-100/90">
                    Every company gets a fully separate workspace. Isolation is enforced by the database itself, not just the interface, and access inside your team is controlled by roles.
                  </p>
                  <div className="mt-8 flex flex-wrap gap-3">
                    <Link to="/signup"><Button variant="light" size="lg">Create Your AI Agent</Button></Link>
                    <Link to="/login"><Button size="lg" variant="ghost" className="text-white hover:bg-white/10">Login</Button></Link>
                  </div>
                </div>
                <ul className="space-y-3">
                  {['Separate data for every business', 'Owner, Admin, Manager and Viewer roles', 'Sessions you can revoke instantly', 'Full audit trail of key actions'].map((t) => (
                    <li key={t} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[15px]">
                      <Check className="size-4 shrink-0 text-burgundy-200" /> {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-mist-200 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 sm:flex-row">
          <Logo size={30} />
          <p className="text-sm text-mist-500">© {new Date().getFullYear()} MicroAgent. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

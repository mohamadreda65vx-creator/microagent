import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { useEffect, useId, useRef } from 'react';

/**
 * The MicroAgent mascot: a friendly floating robot-head. Original artwork (SVG).
 *  - eyes follow the pointer
 *  - blinks, floats, antenna pulses
 *  - orbiting "skill" chips around it are drawn by the parent
 */
export function AnimatedAgent({ className }: { className?: string }) {
  const id = useId();
  const reduce = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 140, damping: 16 });
  const sy = useSpring(py, { stiffness: 140, damping: 16 });
  const eyeX = useTransform(sx, [-1, 1], [-5, 5]);
  const eyeY = useTransform(sy, [-1, 1], [-4, 4]);
  const tiltX = useTransform(sx, [-1, 1], [-3, 3]);
  const tiltY = useTransform(sy, [-1, 1], [-2, 2]);

  useEffect(() => {
    if (reduce) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / Math.max(window.innerWidth / 2, 1);
      const dy = (e.clientY - (r.top + r.height / 2)) / Math.max(window.innerHeight / 2, 1);
      px.set(Math.max(-1, Math.min(1, dx)));
      py.set(Math.max(-1, Math.min(1, dy)));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [px, py, reduce]);

  return (
    <motion.svg
      ref={ref}
      viewBox="0 0 360 380"
      className={className}
      role="img"
      aria-label="MicroAgent, your friendly AI employee"
      animate={reduce ? undefined : { y: [0, -12, 0] }}
      transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="60" y1="70" x2="300" y2="330" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B23A64" />
          <stop offset="0.55" stopColor="#7A2342" />
          <stop offset="1" stopColor="#3F1122" />
        </linearGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#2A0A16" />
          <stop offset="1" stopColor="#1A0610" />
        </linearGradient>
        <radialGradient id={`${id}-eye`} cx="0.5" cy="0.4" r="0.7">
          <stop stopColor="#FFFFFF" />
          <stop offset="0.5" stopColor="#FFD9E3" />
          <stop offset="1" stopColor="#F29BB8" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-20%" y="-20%" width="140%" height="160%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      {/* ground shadow */}
      <motion.ellipse
        cx="180"
        cy="352"
        rx="86"
        ry="10"
        fill="#2A0A16"
        opacity="0.28"
        filter={`url(#${id}-shadow)`}
        animate={reduce ? undefined : { rx: [86, 70, 86], opacity: [0.28, 0.18, 0.28] }}
        transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* antenna */}
      <line x1="180" y1="62" x2="180" y2="92" stroke="#7A2342" strokeWidth="6" strokeLinecap="round" />
      <motion.circle
        cx="180"
        cy="50"
        r="13"
        fill="#F29BB8"
        animate={reduce ? undefined : { scale: [1, 1.18, 1], opacity: [1, 0.75, 1] }}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        transition={{ duration: 2.2, repeat: Infinity }}
      />
      <circle cx="180" cy="50" r="5" fill="#fff" />

      {/* ears */}
      <rect x="40" y="168" width="26" height="70" rx="13" fill="#5C1932" />
      <rect x="294" y="168" width="26" height="70" rx="13" fill="#5C1932" />
      <rect x="48" y="184" width="10" height="38" rx="5" fill="#F29BB8" opacity="0.55" />
      <rect x="302" y="184" width="10" height="38" rx="5" fill="#F29BB8" opacity="0.55" />

      {/* head */}
      <motion.g style={{ x: tiltX, y: tiltY }}>
        <rect x="62" y="92" width="236" height="206" rx="64" fill={`url(#${id}-body)`} />
        <rect x="62" y="92" width="236" height="206" rx="64" fill="none" stroke="#fff" strokeOpacity="0.16" strokeWidth="2" />
        {/* highlight */}
        <path d="M96 128c10-18 32-28 58-30" stroke="#fff" strokeOpacity="0.35" strokeWidth="7" strokeLinecap="round" fill="none" />

        {/* face plate */}
        <rect x="88" y="130" width="184" height="118" rx="44" fill={`url(#${id}-face)`} />
        <rect x="88" y="130" width="184" height="118" rx="44" fill="none" stroke="#C96F8D" strokeOpacity="0.35" />

        {/* eyes */}
        <motion.g style={{ x: eyeX, y: eyeY }}>
          <g className="eye animate-blink">
            <ellipse cx="143" cy="184" rx="19" ry="23" fill={`url(#${id}-eye)`} />
            <circle cx="149" cy="176" r="5.5" fill="#fff" />
          </g>
          <g className="eye animate-blink">
            <ellipse cx="217" cy="184" rx="19" ry="23" fill={`url(#${id}-eye)`} />
            <circle cx="223" cy="176" r="5.5" fill="#fff" />
          </g>
        </motion.g>

        {/* smile */}
        <path d="M156 226c12 10 36 10 48 0" stroke="#F29BB8" strokeWidth="5" strokeLinecap="round" fill="none" />
        {/* cheeks */}
        <ellipse cx="116" cy="216" rx="11" ry="6" fill="#F29BB8" opacity="0.25" />
        <ellipse cx="244" cy="216" rx="11" ry="6" fill="#F29BB8" opacity="0.25" />
      </motion.g>

      {/* body hint + badge */}
      <path d="M118 306c0-14 12-24 26-24h72c14 0 26 10 26 24v18H118z" fill="#5C1932" />
      <rect x="156" y="296" width="48" height="16" rx="8" fill="#F6E4E9" />
      <circle cx="170" cy="304" r="3" fill="#7A2342" />
      <rect x="178" y="301.5" width="20" height="5" rx="2.5" fill="#C96F8D" />
    </motion.svg>
  );
}

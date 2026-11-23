import { Camera, Globe, MessageCircle, MessagesSquare, Send, Music2, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { ChannelType } from './types';

export interface PlatformMeta { type: ChannelType; label: string; short: string; icon: LucideIcon; tint: string; slug: string }

/** The five platforms that have their own conversations section (TikTok is planned: no section yet). */
export const PLATFORMS: PlatformMeta[] = [
  { type: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp', icon: MessageCircle, tint: 'bg-emerald-100 text-emerald-700', slug: 'whatsapp' },
  { type: 'messenger', label: 'Messenger', short: 'Messenger', icon: MessagesSquare, tint: 'bg-blue-100 text-blue-700', slug: 'messenger' },
  { type: 'instagram', label: 'Instagram', short: 'Instagram', icon: Camera, tint: 'bg-pink-100 text-pink-700', slug: 'instagram' },
  { type: 'telegram', label: 'Telegram', short: 'Telegram', icon: Send, tint: 'bg-sky-100 text-sky-700', slug: 'telegram' },
  { type: 'website', label: 'Website Chat', short: 'Website', icon: Globe, tint: 'bg-burgundy-100 text-burgundy-700', slug: 'website' },
];
export const ALL_PLATFORMS: PlatformMeta[] = [...PLATFORMS, { type: 'tiktok', label: 'TikTok', short: 'TikTok', icon: Music2, tint: 'bg-mist-200 text-mist-700', slug: 'tiktok' }];
export const platformOf = (t: string) => ALL_PLATFORMS.find((p) => p.type === t);

export function PlatformBadge({ type, size = 'md' }: { type: ChannelType; size?: 'sm' | 'md' | 'lg' }) {
  const p = platformOf(type)!;
  const s = size === 'sm' ? 'size-6' : size === 'lg' ? 'size-11' : 'size-8';
  const i = size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4';
  return (
    <span className={clsx('grid shrink-0 place-items-center rounded-lg', s, p.tint)} title={p.label}>
      <p.icon className={i} strokeWidth={1.9} />
    </span>
  );
}

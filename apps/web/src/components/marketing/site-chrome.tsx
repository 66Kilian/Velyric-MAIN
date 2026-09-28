'use client';

import { VelyricLogo, cn } from '@velyric/ui';
import { Mail, MapPin, Menu, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { LanguageMenu, ThemeMenu } from '@/components/shell/preferences';
import { Link } from '@/i18n/navigation';
import type { MarketingHref } from '@/components/marketing/sections';

interface NavItem {
  readonly key: string;
  readonly href: MarketingHref;
}

export interface FooterContact {
  readonly address: string;
  readonly salesEmail: string;
  readonly registration: string;
}

const NAV: readonly NavItem[] = [
  { key: 'product', href: { pathname: '/product' } },
  { key: 'aiReceptionist', href: { pathname: '/ai-receptionist' } },
  { key: 'solutions', href: { pathname: '/solutions/[vertical]', params: { vertical: 'restaurants' } } },
  { key: 'pricing', href: { pathname: '/pricing' } },
  { key: 'integrations', href: { pathname: '/integrations' } },
  { key: 'docs', href: { pathname: '/docs' } },
];

export function MarketingHeader() {
  const t = useTranslations('navigation.marketing');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-bg/70 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 md:px-8">
        <Link href="/" aria-label={tc('brand.name')}>
          <VelyricLogo />
        </Link>
        <nav
          aria-label={tc('brand.name')}
          className="mx-auto hidden items-center gap-7 text-[14px] font-medium text-text lg:flex"
        >
          {NAV.map((item) => (
            <Link key={item.key} href={item.href} className="hover:text-pink-text">
              {t(item.key)}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          <LanguageMenu mode="marketing" className="hidden sm:inline-flex" />
          <ThemeMenu className="hidden sm:inline-flex" />
          <Link
            href="/login"
            className="hidden px-3 text-[14px] font-medium text-text hover:text-pink-text sm:inline"
          >
            {tc('actions.signIn')}
          </Link>
          <Link
            href="/signup"
            className="vly-gradient-cta hidden h-10 items-center rounded-full px-5 text-[14px] font-semibold shadow-cta sm:inline-flex"
          >
            {tc('actions.signUp')}
          </Link>
          <button
            type="button"
            className="rounded-md p-2 text-text lg:hidden"
            onClick={() => {
              setOpen((value) => !value);
            }}
            aria-expanded={open}
            aria-controls="marketing-mobile-nav"
            aria-label={open ? tc('a11y.closeMenu') : tc('a11y.openMenu')}
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div
        id="marketing-mobile-nav"
        hidden={!open}
        className="border-t border-border bg-surface px-4 pb-4 lg:hidden"
      >
        <nav className="flex flex-col py-2">
          {NAV.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="py-2.5 text-[15px] font-medium text-text"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t(item.key)}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <LanguageMenu mode="marketing" />
          <ThemeMenu />
          <Link href="/login" className="ml-auto px-3 text-[14px] font-medium text-text">
            {tc('actions.signIn')}
          </Link>
          <Link
            href="/signup"
            className="vly-gradient-cta inline-flex h-10 items-center rounded-full px-5 text-[14px] font-semibold shadow-cta"
          >
            {tc('actions.signUp')}
          </Link>
        </div>
      </div>
    </header>
  );
}

const FOOTER_SERVICE_LINKS: readonly NavItem[] = [
  { key: 'product', href: { pathname: '/product' } },
  { key: 'aiReceptionist', href: { pathname: '/ai-receptionist' } },
  { key: 'appointmentBooking', href: { pathname: '/appointment-booking' } },
  { key: 'multilingual', href: { pathname: '/multilingual' } },
  { key: 'callTransfer', href: { pathname: '/call-transfer' } },
  { key: 'pricing', href: { pathname: '/pricing' } },
];

const FOOTER_RESOURCE_LINKS: readonly NavItem[] = [
  { key: 'integrations', href: { pathname: '/integrations' } },
  { key: 'docs', href: { pathname: '/docs' } },
  { key: 'glossary', href: { pathname: '/glossary' } },
  { key: 'security', href: { pathname: '/security' } },
  { key: 'contact', href: { pathname: '/contact' } },
];

const FOOTER_LEGAL_LINKS = [
  { key: 'privacy', href: '/legal/privacy' },
  { key: 'terms', href: '/legal/terms' },
  { key: 'dpa', href: '/legal/dpa' },
  { key: 'status', href: '/status' },
] as const;

export function MarketingFooter({
  contact,
  year,
  className,
}: {
  readonly contact: FooterContact;
  readonly year: number;
  readonly className?: string;
}) {
  const t = useTranslations('navigation.marketing');
  const tc = useTranslations('common');
  return (
    <footer className={cn('border-t border-border bg-surface', className)}>
      <div className="mx-auto w-full max-w-7xl px-4 py-12 md:px-8">
        <div className="grid gap-10 md:grid-cols-[1.3fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-4">
            <VelyricLogo />
            <p className="max-w-xs text-[14px] text-text-muted">{t('footer.description')}</p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text">
              {t('footer.servicesHeading')}
            </h3>
            <nav className="mt-4 flex flex-col gap-2.5 text-[14px] text-text-muted">
              {FOOTER_SERVICE_LINKS.map((item) => (
                <Link key={item.key} href={item.href} className="hover:text-text">
                  {t(item.key)}
                </Link>
              ))}
            </nav>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text">
              {t('footer.infoHeading')}
            </h3>
            <nav className="mt-4 flex flex-col gap-2.5 text-[14px] text-text-muted">
              {FOOTER_RESOURCE_LINKS.map((item) => (
                <Link key={item.key} href={item.href} className="hover:text-text">
                  {t(item.key)}
                </Link>
              ))}
              {FOOTER_LEGAL_LINKS.map((item) => (
                <a key={item.key} href={item.href} className="hover:text-text">
                  {t(item.key)}
                </a>
              ))}
            </nav>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text">
              {t('footer.contactHeading')}
            </h3>
            <ul className="mt-4 flex flex-col gap-2.5 text-[14px] text-text-muted">
              <li className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{contact.address}</span>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
                <a href={`mailto:${contact.salesEmail}`} className="hover:text-text">
                  {contact.salesEmail}
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center gap-4 border-t border-border pt-6 text-[13px] text-text-muted md:flex-row md:justify-between">
          <div className="flex items-center gap-3">
            <span>
              {tc('brand.name')} · {t('footer.registration')} {contact.registration}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <LanguageMenu mode="marketing" />
            <ThemeMenu />
            <span>
              © {year} {tc('brand.name')}. {t('footer.rights')}
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

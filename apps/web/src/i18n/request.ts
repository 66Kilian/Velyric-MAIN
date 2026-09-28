import { cookies } from 'next/headers';
import { IntlErrorCode } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { loadMessages } from './messages';
import { isAppLocale, LOCALE_COOKIE, routing, type AppLocale } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  let locale: AppLocale = routing.defaultLocale;
  if (isAppLocale(requested)) {
    locale = requested;
  } else {
    const store = await cookies();
    const preferred = store.get('vly_account_locale')?.value ?? store.get(LOCALE_COOKIE)?.value;
    if (isAppLocale(preferred)) {
      locale = preferred;
    }
  }
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: 'Europe/Budapest',
    onError: (error) => {
      if (error.code !== IntlErrorCode.MISSING_MESSAGE || process.env['VELYRIC_ENV'] === 'ci') {
        process.stderr.write(`i18n ${error.code}: ${error.originalMessage ?? error.message}\n`);
      }
    },
    getMessageFallback: ({ namespace, key }) => [namespace, key].filter(Boolean).join('.'),
  };
});

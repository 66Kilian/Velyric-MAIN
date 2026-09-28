'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { passwordStrengthIssues } from '@velyric/security';
import { Button, Field, Input, VelyricMark } from '@velyric/ui';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { issueFor, useApiErrorMessage, validationIssues } from '@/components/common/use-api-error';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-types';
import { TurnstileWidget } from './turnstile-widget';

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const signUpSchema = z.object({
  email: z.email(),
  password: z.string().refine((value) => passwordStrengthIssues(value).length === 0),
});

type SignInForm = z.infer<typeof signInSchema>;
type SignUpForm = z.infer<typeof signUpSchema>;

export function AuthEntry({
  mode,
  returnTo,
  turnstileSiteKey = null,
}: {
  readonly mode: 'sign-in' | 'sign-up';
  readonly returnTo: string;
  readonly turnstileSiteKey?: string | null;
}) {
  const t = useTranslations(`auth.${mode === 'sign-in' ? 'signIn' : 'signUp'}`);
  const ta = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorMessage = useApiErrorMessage();
  const googleErrorCode = searchParams.get('error');
  const [formError, setFormError] = useState<string | null>(
    googleErrorCode !== null && ta.has(`googleError.${googleErrorCode}`)
      ? ta(`googleError.${googleErrorCode}`)
      : null,
  );

  const signIn = useForm<SignInForm>({ resolver: zodResolver(signInSchema) });
  const signUp = useForm<SignUpForm>({ resolver: zodResolver(signUpSchema) });
  const form = mode === 'sign-in' ? signIn : signUp;
  const { register, handleSubmit, formState, setError } = form;

  // An invitation sends people here with the page they should land on; keep it
  // when they switch between signing in and signing up.
  const switchPathname = mode === 'sign-in' ? '/signup' : '/login';
  const carriesReturnTo = returnTo !== '/app' && returnTo !== '/app/onboarding';

  const requiresTurnstile = mode === 'sign-up' && turnstileSiteKey !== null;
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);

  const fieldMessage = (field: 'email' | 'password') => {
    const code = formState.errors[field]?.message;
    if (code === undefined) {
      return undefined;
    }
    return ta.has(`fieldErrors.${code}`) ? ta(`fieldErrors.${code}`) : ta('fieldErrors.invalid');
  };

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    if (requiresTurnstile && turnstileToken === null) {
      return;
    }
    try {
      if (mode === 'sign-in') {
        await api.post('/auth/login', { body: values });
      } else {
        await api.post('/auth/register', {
          body: requiresTurnstile ? { ...values, turnstile_token: turnstileToken } : values,
        });
      }
      router.push(returnTo);
      router.refresh();
    } catch (error) {
      if (requiresTurnstile) {
        // Turnstile tokens are single-use; get a fresh one for the next attempt.
        setTurnstileToken(null);
        setTurnstileAttempt((attempt) => attempt + 1);
      }
      if (error instanceof ApiRequestError) {
        if (error.code === 'INVALID_CREDENTIALS' || error.code === 'ACCOUNT_LOCKED') {
          setFormError(errorMessage(error).title);
          return;
        }
        if (error.code === 'EMAIL_ALREADY_REGISTERED') {
          setError('email', { type: 'server', message: 'email_taken' });
          return;
        }
        if (error.code === 'WEAK_PASSWORD') {
          setError('password', { type: 'server', message: 'too_weak' });
          return;
        }
        for (const field of ['email', 'password'] as const) {
          if (issueFor(validationIssues(error), field) !== undefined) {
            setError(field, { type: 'server', message: 'invalid' });
          }
        }
      }
      setFormError(errorMessage(error).title);
    }
  });

  return (
    <section className="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:px-8">
      <div className="flex flex-col gap-4">
        <VelyricMark className="h-12 w-auto self-start" />
        <h1 className="text-[36px] font-bold leading-tight tracking-[-0.03em] text-text">
          {t('title')}
        </h1>
        <p className="text-lg text-text-muted">{t('body')}</p>
        <ul className="flex flex-col gap-2 text-sm text-text">
          {(['secure', 'languages', 'support'] as const).map((key) => (
            <li key={key} className="flex items-center gap-2">
              <Check className="h-4 w-4 text-pink" aria-hidden="true" />
              {ta(`benefits.${key}`)}
            </li>
          ))}
        </ul>
      </div>
      <div className="vly-glass flex flex-col gap-5 rounded-2xl p-8">
        <a
          href={`/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`}
          rel="nofollow"
          className="flex h-12 items-center justify-center gap-3 rounded-full border border-border bg-surface text-[15px] font-semibold text-text transition hover:bg-surface-muted"
        >
          <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A24 24 0 0 0 0 24c0 3.87.92 7.53 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.9l-7.97 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
          {ta('googleButton')}
        </a>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
          {ta('orDivider')}
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field id="auth-email" label={ta('emailLabel')} required error={fieldMessage('email')}>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              autoFocus
              {...register('email')}
            />
          </Field>
          <Field
            id="auth-password"
            label={ta('passwordLabel')}
            hint={mode === 'sign-up' ? ta('passwordHint') : undefined}
            required
            error={fieldMessage('password')}
          >
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              {...register('password')}
            />
          </Field>
          {formError !== null ? <p className="text-sm text-danger-text">{formError}</p> : null}
          {requiresTurnstile ? (
            <TurnstileWidget
              key={turnstileAttempt}
              siteKey={turnstileSiteKey}
              onToken={setTurnstileToken}
            />
          ) : null}
          <Button
            type="submit"
            loading={formState.isSubmitting}
            disabled={formState.isSubmitting || (requiresTurnstile && turnstileToken === null)}
            className="vly-gradient-cta h-12 rounded-full text-[15px] font-semibold shadow-cta"
          >
            {t('button')}
          </Button>
        </form>
        <p className="border-t border-border pt-4 text-center text-sm text-text-muted">
          {t('switchPrompt')}{' '}
          <Link
            href={
              carriesReturnTo
                ? { pathname: switchPathname, query: { return_to: returnTo } }
                : switchPathname
            }
            className="font-semibold text-violet-text hover:underline"
          >
            {t('switchLink')}
          </Link>
        </p>
        <p className="text-center text-xs text-text-muted">
          {ta.rich('legal', {
            terms: (chunks) => (
              <a href="/legal/terms" className="underline">
                {chunks}
              </a>
            ),
            privacy: (chunks) => (
              <a href="/legal/privacy" className="underline">
                {chunks}
              </a>
            ),
          })}
        </p>
      </div>
    </section>
  );
}

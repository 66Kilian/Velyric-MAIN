import 'server-only';

export type WebEnvironment = 'local' | 'ci' | 'staging' | 'production';

export interface WebConfig {
  readonly environment: WebEnvironment;
  readonly publicWebOrigin: string;
  readonly controlApiUrl: string;
  readonly statusPageUrl: string | null;
  readonly gaMeasurementId: string | null;
  readonly hetrixtoolsApiKey: string | null;
  readonly voicePreviewApiKey: string | null;
  readonly turnstileSiteKey: string | null;
  readonly webTestCallEnabled: boolean;
  readonly publicIndexing: boolean;
  readonly searchConsoleVerification: string | null;
  readonly bingVerification: string | null;
  readonly termsVersion: string;
  readonly legalEntity: {
    readonly name: string;
    readonly address: string;
    readonly registration: string;
    readonly taxNumber: string;
    readonly privacyEmail: string;
    readonly salesEmail: string;
  };
  readonly csrfCookieName: string;
  readonly secureCookies: boolean;
}

const ENVIRONMENTS: readonly WebEnvironment[] = ['local', 'ci', 'staging', 'production'];

export class WebConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid web configuration: ${issues.join('; ')}`);
    this.name = 'WebConfigError';
    this.issues = issues;
  }
}

function origin(
  value: string | undefined,
  name: string,
  issues: string[],
  requireHttps: boolean,
): string {
  if (value === undefined || value.trim() === '') {
    issues.push(`${name} is required`);
    return '';
  }
  try {
    const url = new URL(value);
    if (
      url.pathname !== '/' ||
      url.search !== '' ||
      (requireHttps && url.protocol !== 'https:') ||
      !['http:', 'https:'].includes(url.protocol)
    ) {
      issues.push(`${name} must be an ${requireHttps ? 'https ' : ''}origin`);
    }
    return url.origin;
  } catch {
    issues.push(`${name} must be a URL`);
    return '';
  }
}

export function parseWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const issues: string[] = [];
  const rawEnvironment = env['VELYRIC_ENV'] ?? '';
  const environment = (ENVIRONMENTS as readonly string[]).includes(rawEnvironment)
    ? (rawEnvironment as WebEnvironment)
    : 'production';
  if (!(ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    issues.push('VELYRIC_ENV must be one of local, ci, staging, production');
  }
  const deployed = environment === 'staging' || environment === 'production';
  const indexingRaw = env['VELYRIC_PUBLIC_INDEXING'];
  if (indexingRaw !== undefined && indexingRaw !== '' && !['true', 'false'].includes(indexingRaw)) {
    issues.push('VELYRIC_PUBLIC_INDEXING must be true or false');
  }
  const publicIndexing =
    indexingRaw === undefined || indexingRaw === ''
      ? environment === 'production'
      : indexingRaw === 'true';
  const publicWebOrigin = origin(
    env['VELYRIC_PUBLIC_WEB_ORIGIN'],
    'VELYRIC_PUBLIC_WEB_ORIGIN',
    issues,
    deployed,
  );
  const controlApiUrl = origin(
    env['VELYRIC_CONTROL_API_URL'],
    'VELYRIC_CONTROL_API_URL',
    issues,
    false,
  );
  const statusRaw = env['VELYRIC_STATUS_PAGE_URL'];
  const statusPageUrl = statusRaw === undefined || statusRaw === '' ? null : statusRaw;
  if (statusPageUrl !== null && !/^https:\/\//.test(statusPageUrl)) {
    issues.push('VELYRIC_STATUS_PAGE_URL must be an https URL');
  }
  const gaRaw = env['VELYRIC_GA_MEASUREMENT_ID'];
  const gaMeasurementId = gaRaw === undefined || gaRaw === '' ? null : gaRaw;
  if (gaMeasurementId !== null && !/^G-[A-Z0-9]{4,20}$/.test(gaMeasurementId)) {
    issues.push('VELYRIC_GA_MEASUREMENT_ID must look like G-XXXXXXXXXX');
  }
  const hetrixtoolsRaw = env['VELYRIC_HETRIXTOOLS_API_KEY_SECRET'];
  const hetrixtoolsApiKey =
    hetrixtoolsRaw === undefined || hetrixtoolsRaw === '' ? null : hetrixtoolsRaw;
  const verificationToken = (name: string): string | null => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(raw)) {
      issues.push(`${name} must be a search engine verification token`);
      return null;
    }
    return raw;
  };
  const searchConsoleVerification = verificationToken('VELYRIC_GOOGLE_SITE_VERIFICATION');
  const bingVerification = verificationToken('VELYRIC_BING_SITE_VERIFICATION');
  const termsVersion = env['VELYRIC_TERMS_VERSION'] ?? '';
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(termsVersion)) {
    issues.push(
      'VELYRIC_TERMS_VERSION must be a YYYY-MM-DD date matching the control-api terms version',
    );
  }
  const legalEntity = {
    name: env['VELYRIC_LEGAL_ENTITY_NAME'] ?? '',
    address: env['VELYRIC_LEGAL_ENTITY_ADDRESS'] ?? '',
    registration: env['VELYRIC_LEGAL_ENTITY_REGISTRATION'] ?? '',
    taxNumber: env['VELYRIC_LEGAL_ENTITY_TAX_NUMBER'] ?? '',
    privacyEmail: env['VELYRIC_PRIVACY_CONTACT_EMAIL'] ?? '',
    salesEmail: env['VELYRIC_SALES_CONTACT_EMAIL'] ?? '',
  };
  for (const [key, value] of Object.entries(legalEntity)) {
    if (value.trim() === '') {
      issues.push(
        `legal entity field ${key} is required (VELYRIC_LEGAL_ENTITY_* / VELYRIC_PRIVACY_CONTACT_EMAIL)`,
      );
    }
  }
  for (const [name, value] of [
    ['VELYRIC_PRIVACY_CONTACT_EMAIL', legalEntity.privacyEmail],
    ['VELYRIC_SALES_CONTACT_EMAIL', legalEntity.salesEmail],
  ] as const) {
    if (value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      issues.push(`${name} must be an email address`);
    }
  }
  if (issues.length > 0) {
    throw new WebConfigError(issues);
  }
  return {
    environment,
    publicIndexing,
    publicWebOrigin,
    controlApiUrl,
    statusPageUrl,
    gaMeasurementId,
    hetrixtoolsApiKey,
    voicePreviewApiKey: (env['VELYRIC_VOICE_PREVIEW_OPENAI_API_KEY'] ?? '').trim() || null,
    turnstileSiteKey: (env['VELYRIC_TURNSTILE_SITE_KEY'] ?? '').trim() || null,
    webTestCallEnabled: env['VELYRIC_WEB_TEST_CALL_ENABLED'] === 'true',
    searchConsoleVerification,
    bingVerification,
    termsVersion,
    legalEntity,
    csrfCookieName: deployed ? '__Host-vly_csrf' : 'vly_csrf',
    secureCookies: deployed,
  };
}

let cached: WebConfig | null = null;

export function webConfig(): WebConfig {
  cached ??= parseWebConfig(process.env);
  return cached;
}

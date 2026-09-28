export type NotificationLocale = 'hu' | 'de' | 'en';

export type TemplatedNotificationType =
  | 'RENEWAL_REMINDER_5D'
  | 'RENEWAL_REMINDER_3D'
  | 'RENEWAL_REMINDER_1D'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED_GRACE_STARTED'
  | 'GRACE_PERIOD_REMINDER'
  | 'GRACE_PERIOD_FINAL_DAY'
  | 'SERVICE_SUSPENDED_BILLING'
  | 'SERVICE_REACTIVATED'
  | 'PROVISIONING_STARTED'
  | 'PROVISIONING_KYC_REQUIRED'
  | 'PROVISIONING_KYC_DECLINED'
  | 'PROVISIONING_DELAYED'
  | 'PHONE_NUMBER_ACTIVE'
  | 'TEST_CALL_READY'
  | 'GO_LIVE_COMPLETED'
  | 'INVOICE_DELIVERY_FAILED'
  | 'SECURITY_MEMBER_INVITED'
  | 'SECURITY_MEMBER_ROLE_CHANGED'
  | 'SECURITY_API_KEY_CREATED'
  | 'SUPPORT_REQUEST_RECEIVED'
  | 'SUPPORT_REQUEST_UPDATED';

export const TEMPLATE_VERSION = '2026-09-19.1';

interface Template {
  readonly subject: string;
  readonly body: readonly string[];
  readonly action?: { readonly label: string; readonly urlKey: string };
}

type Catalog = Readonly<
  Record<TemplatedNotificationType, Readonly<Record<NotificationLocale, Template>>>
>;

const CATALOG: Catalog = {
  RENEWAL_REMINDER_5D: {
    hu: {
      subject: 'Velyric előfizetésed 5 nap múlva megújul',
      body: [
        'A(z) {{plan_name}} csomagod {{renewal_date}} napon megújul, a díj {{amount_display}}.',
        'Ha a fizetési adataid változtak, frissítsd őket időben.',
      ],
      action: { label: 'Számlázás megnyitása', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Ihr Velyric-Abonnement verlängert sich in 5 Tagen',
      body: [
        'Ihr Tarif {{plan_name}} verlängert sich am {{renewal_date}} zum Preis von {{amount_display}}.',
        'Bitte aktualisieren Sie Ihre Zahlungsdaten rechtzeitig, falls sie sich geändert haben.',
      ],
      action: { label: 'Abrechnung öffnen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Your Velyric subscription renews in 5 days',
      body: [
        'Your {{plan_name}} plan renews on {{renewal_date}} for {{amount_display}}.',
        'If your payment details changed, please update them in time.',
      ],
      action: { label: 'Open billing', urlKey: 'billing_url' },
    },
  },
  RENEWAL_REMINDER_3D: {
    hu: {
      subject: 'Velyric előfizetésed 3 nap múlva megújul',
      body: [
        'A(z) {{plan_name}} csomagod {{renewal_date}} napon megújul, a díj {{amount_display}}.',
      ],
      action: { label: 'Számlázás megnyitása', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Ihr Velyric-Abonnement verlängert sich in 3 Tagen',
      body: [
        'Ihr Tarif {{plan_name}} verlängert sich am {{renewal_date}} zum Preis von {{amount_display}}.',
      ],
      action: { label: 'Abrechnung öffnen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Your Velyric subscription renews in 3 days',
      body: ['Your {{plan_name}} plan renews on {{renewal_date}} for {{amount_display}}.'],
      action: { label: 'Open billing', urlKey: 'billing_url' },
    },
  },
  RENEWAL_REMINDER_1D: {
    hu: {
      subject: 'Velyric előfizetésed holnap megújul',
      body: [
        'A(z) {{plan_name}} csomagod holnap ({{renewal_date}}) megújul, a díj {{amount_display}}.',
      ],
      action: { label: 'Számlázás megnyitása', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Ihr Velyric-Abonnement verlängert sich morgen',
      body: [
        'Ihr Tarif {{plan_name}} verlängert sich morgen ({{renewal_date}}) zum Preis von {{amount_display}}.',
      ],
      action: { label: 'Abrechnung öffnen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Your Velyric subscription renews tomorrow',
      body: ['Your {{plan_name}} plan renews tomorrow ({{renewal_date}}) for {{amount_display}}.'],
      action: { label: 'Open billing', urlKey: 'billing_url' },
    },
  },
  PAYMENT_SUCCEEDED: {
    hu: {
      subject: 'Sikeres fizetés – Velyric',
      body: [
        'Köszönjük! {{amount_display}} összegű fizetésedet rögzítettük.',
        'A számlát e-mailben küldjük, és a Számlázás oldalon is elérhető.',
      ],
    },
    de: {
      subject: 'Zahlung erfolgreich – Velyric',
      body: [
        'Vielen Dank! Ihre Zahlung über {{amount_display}} wurde verbucht.',
        'Die Rechnung erhalten Sie per E-Mail und im Bereich Abrechnung.',
      ],
    },
    en: {
      subject: 'Payment received – Velyric',
      body: [
        'Thank you! Your payment of {{amount_display}} was recorded.',
        'The invoice is sent by email and is available on the Billing page.',
      ],
    },
  },
  PAYMENT_FAILED_GRACE_STARTED: {
    hu: {
      subject: 'Sikertelen fizetés – türelmi idő indult',
      body: [
        'A(z) {{amount_display}} összegű megújítás nem sikerült.',
        'A szolgáltatás {{grace_ends_at}}-ig működik tovább. Kérjük, frissítsd a fizetési módot.',
      ],
      action: { label: 'Fizetési mód frissítése', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Zahlung fehlgeschlagen – Kulanzfrist gestartet',
      body: [
        'Die Verlängerung über {{amount_display}} ist fehlgeschlagen.',
        'Der Dienst läuft bis {{grace_ends_at}} weiter. Bitte aktualisieren Sie Ihre Zahlungsmethode.',
      ],
      action: { label: 'Zahlungsmethode aktualisieren', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Payment failed – grace period started',
      body: [
        'The renewal payment of {{amount_display}} failed.',
        'Your service keeps running until {{grace_ends_at}}. Please update your payment method.',
      ],
      action: { label: 'Update payment method', urlKey: 'billing_url' },
    },
  },
  GRACE_PERIOD_REMINDER: {
    hu: {
      subject: 'Emlékeztető: rendezetlen Velyric fizetés',
      body: [
        'A türelmi idő {{grace_ends_at}}-kor lejár. Utána a hívásfogadás szünetel, a beállításaid megmaradnak.',
      ],
      action: { label: 'Fizetés rendezése', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Erinnerung: offene Velyric-Zahlung',
      body: [
        'Die Kulanzfrist endet am {{grace_ends_at}}. Danach wird die Anrufannahme pausiert, Ihre Einstellungen bleiben erhalten.',
      ],
      action: { label: 'Zahlung abschließen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Reminder: Velyric payment outstanding',
      body: [
        'The grace period ends at {{grace_ends_at}}. After that call handling pauses; your configuration is kept.',
      ],
      action: { label: 'Settle payment', urlKey: 'billing_url' },
    },
  },
  GRACE_PERIOD_FINAL_DAY: {
    hu: {
      subject: 'Ma jár le a türelmi idő',
      body: [
        'Ha ma nem rendeződik a fizetés, {{grace_ends_at}}-kor a szolgáltatás felfüggesztésre kerül.',
      ],
      action: { label: 'Fizetés rendezése', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Die Kulanzfrist endet heute',
      body: [
        'Wenn die Zahlung heute nicht erfolgt, wird der Dienst am {{grace_ends_at}} ausgesetzt.',
      ],
      action: { label: 'Zahlung abschließen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Your grace period ends today',
      body: ['If the payment is not settled today, the service is suspended at {{grace_ends_at}}.'],
      action: { label: 'Settle payment', urlKey: 'billing_url' },
    },
  },
  SERVICE_SUSPENDED_BILLING: {
    hu: {
      subject: 'A Velyric szolgáltatás felfüggesztve',
      body: [
        'Rendezetlen fizetés miatt a hívásfogadás szünetel. Az agentek, a tudásbázis és az integrációk megmaradnak.',
        'A fizetés rendezése után a szolgáltatás automatikusan újraindul.',
      ],
      action: { label: 'Fizetés rendezése', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Velyric-Dienst ausgesetzt',
      body: [
        'Wegen einer offenen Zahlung ist die Anrufannahme pausiert. Agenten, Wissensbasis und Integrationen bleiben erhalten.',
        'Nach Zahlungseingang wird der Dienst automatisch fortgesetzt.',
      ],
      action: { label: 'Zahlung abschließen', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Velyric service suspended',
      body: [
        'Call handling is paused because of an outstanding payment. Agents, knowledge and integrations are kept.',
        'The service resumes automatically once the payment is settled.',
      ],
      action: { label: 'Settle payment', urlKey: 'billing_url' },
    },
  },
  SERVICE_REACTIVATED: {
    hu: {
      subject: 'A Velyric szolgáltatás újra aktív',
      body: ['Köszönjük a fizetést! A hívásfogadás újra működik a korábbi beállításokkal.'],
    },
    de: {
      subject: 'Velyric-Dienst wieder aktiv',
      body: [
        'Vielen Dank für Ihre Zahlung! Die Anrufannahme läuft wieder mit Ihren bisherigen Einstellungen.',
      ],
    },
    en: {
      subject: 'Velyric service reactivated',
      body: [
        'Thank you for your payment! Call handling is running again with your previous configuration.',
      ],
    },
  },
  PROVISIONING_STARTED: {
    hu: {
      subject: 'Elindult a Velyric fiókod beállítása',
      body: [
        'A(z) {{plan_name}} csomag kifizetése megérkezett. Megkezdtük a telefonszám és a hangasszisztens előkészítését.',
      ],
      action: { label: 'Állapot megtekintése', urlKey: 'action_url' },
    },
    de: {
      subject: 'Die Einrichtung Ihres Velyric-Kontos hat begonnen',
      body: [
        'Die Zahlung für den Tarif {{plan_name}} ist eingegangen. Wir bereiten Rufnummer und Sprachassistent vor.',
      ],
      action: { label: 'Status ansehen', urlKey: 'action_url' },
    },
    en: {
      subject: 'Your Velyric account setup has started',
      body: [
        'Payment for the {{plan_name}} plan was received. We are preparing your phone number and voice assistant.',
      ],
      action: { label: 'View status', urlKey: 'action_url' },
    },
  },
  PROVISIONING_KYC_REQUIRED: {
    hu: {
      subject: 'Adatok szükségesek a telefonszámhoz',
      body: [
        'A(z) {{phone_number}} szám aktiválásához a szolgáltató hatósági adatokat kér.',
        'Kérjük, töltsd ki a hiányzó adatokat a dashboardon.',
      ],
      action: { label: 'Adatok megadása', urlKey: 'action_url' },
    },
    de: {
      subject: 'Angaben für Ihre Rufnummer erforderlich',
      body: [
        'Für die Aktivierung von {{phone_number}} verlangt der Anbieter regulatorische Angaben.',
        'Bitte ergänzen Sie die fehlenden Angaben im Dashboard.',
      ],
      action: { label: 'Angaben ergänzen', urlKey: 'action_url' },
    },
    en: {
      subject: 'Details required for your phone number',
      body: [
        'The carrier requires regulatory details to activate {{phone_number}}.',
        'Please complete the missing details in the dashboard.',
      ],
      action: { label: 'Provide details', urlKey: 'action_url' },
    },
  },
  PROVISIONING_KYC_DECLINED: {
    hu: {
      subject: 'A telefonszám igénylését elutasították',
      body: [
        'A szolgáltató elutasította a(z) {{phone_number}} igénylését. Indok: {{reason}}.',
        'Ügyfélszolgálatunk felveszi veled a kapcsolatot a folytatáshoz.',
      ],
      action: { label: 'Részletek', urlKey: 'action_url' },
    },
    de: {
      subject: 'Rufnummernantrag abgelehnt',
      body: [
        'Der Anbieter hat den Antrag für {{phone_number}} abgelehnt. Grund: {{reason}}.',
        'Unser Support meldet sich bei Ihnen, um fortzufahren.',
      ],
      action: { label: 'Details', urlKey: 'action_url' },
    },
    en: {
      subject: 'Phone number request declined',
      body: [
        'The carrier declined the request for {{phone_number}}. Reason: {{reason}}.',
        'Our support team will contact you to continue.',
      ],
      action: { label: 'Details', urlKey: 'action_url' },
    },
  },
  PROVISIONING_DELAYED: {
    hu: {
      subject: 'Késik a Velyric fiókod beállítása',
      body: [
        'A beállítás egy lépése kézi ellenőrzést igényel ({{reason}}). A kifizetett szolgáltatás nem vész el, hamarosan jelentkezünk.',
      ],
    },
    de: {
      subject: 'Die Einrichtung Ihres Velyric-Kontos verzögert sich',
      body: [
        'Ein Einrichtungsschritt erfordert eine manuelle Prüfung ({{reason}}). Ihr bezahlter Dienst bleibt erhalten, wir melden uns in Kürze.',
      ],
    },
    en: {
      subject: 'Your Velyric setup is delayed',
      body: [
        'One setup step needs a manual review ({{reason}}). Your paid service is not lost; we will be in touch shortly.',
      ],
    },
  },
  PHONE_NUMBER_ACTIVE: {
    hu: {
      subject: 'Aktív a Velyric telefonszámod',
      body: [
        'A(z) {{phone_number}} szám aktív. Publikáld az agentet, és indítsd el az éles hívásfogadást.',
      ],
    },
    de: {
      subject: 'Ihre Velyric-Rufnummer ist aktiv',
      body: [
        'Die Rufnummer {{phone_number}} ist aktiv. Veröffentlichen Sie Ihren Agenten, um live zu gehen.',
      ],
    },
    en: {
      subject: 'Your Velyric phone number is active',
      body: ['{{phone_number}} is active. Publish your agent to start taking live calls.'],
    },
  },
  TEST_CALL_READY: {
    hu: {
      subject: 'Indulhat a próbahívás',
      body: ['A(z) {{phone_number}} számra már hívhatsz próbát az agenteddel.'],
      action: { label: 'Próbahívás útmutató', urlKey: 'action_url' },
    },
    de: {
      subject: 'Testanruf bereit',
      body: ['Sie können jetzt einen Testanruf an {{phone_number}} mit Ihrem Agenten durchführen.'],
      action: { label: 'Anleitung für den Testanruf', urlKey: 'action_url' },
    },
    en: {
      subject: 'Test call ready',
      body: ['You can now place a test call to {{phone_number}} with your agent.'],
      action: { label: 'Test call guide', urlKey: 'action_url' },
    },
  },
  GO_LIVE_COMPLETED: {
    hu: {
      subject: 'Élesben fut a Velyric hangasszisztensed',
      body: ['A(z) {{phone_number}} számon beérkező hívásokat mostantól az agented fogadja.'],
    },
    de: {
      subject: 'Ihr Velyric-Sprachassistent ist live',
      body: [
        'Eingehende Anrufe an {{phone_number}} werden ab sofort von Ihrem Agenten angenommen.',
      ],
    },
    en: {
      subject: 'Your Velyric voice assistant is live',
      body: ['Incoming calls to {{phone_number}} are now answered by your agent.'],
    },
  },
  INVOICE_DELIVERY_FAILED: {
    hu: {
      subject: 'Nem sikerült kézbesíteni a számlát',
      body: [
        'A(z) {{invoice_number}} számú számlát nem tudtuk elküldeni a(z) {{billing_email}} címre. Ellenőrizd a számlázási e-mail címet.',
      ],
      action: { label: 'Számlázási adatok', urlKey: 'billing_url' },
    },
    de: {
      subject: 'Rechnung konnte nicht zugestellt werden',
      body: [
        'Die Rechnung {{invoice_number}} konnte nicht an {{billing_email}} gesendet werden. Bitte prüfen Sie die Rechnungs-E-Mail-Adresse.',
      ],
      action: { label: 'Rechnungsdaten', urlKey: 'billing_url' },
    },
    en: {
      subject: 'Invoice could not be delivered',
      body: [
        'Invoice {{invoice_number}} could not be sent to {{billing_email}}. Please check your billing email address.',
      ],
      action: { label: 'Billing details', urlKey: 'billing_url' },
    },
  },
  SECURITY_MEMBER_INVITED: {
    hu: {
      subject: 'Meghívást kaptál a(z) {{workspace_name}} Velyric fiókba',
      body: [
        '{{inviter_name}} meghívott a(z) {{workspace_name}} munkaterületre {{role_label}} szerepkörrel.',
        'A meghívó {{expires_at}}-ig érvényes. Ha nem vártad ezt a levelet, hagyd figyelmen kívül.',
      ],
      action: { label: 'Meghívó elfogadása', urlKey: 'accept_url' },
    },
    de: {
      subject: 'Einladung in das Velyric-Konto {{workspace_name}}',
      body: [
        '{{inviter_name}} hat Sie mit der Rolle {{role_label}} in den Arbeitsbereich {{workspace_name}} eingeladen.',
        'Die Einladung ist bis {{expires_at}} gültig. Wenn Sie diese E-Mail nicht erwartet haben, ignorieren Sie sie.',
      ],
      action: { label: 'Einladung annehmen', urlKey: 'accept_url' },
    },
    en: {
      subject: 'You were invited to the {{workspace_name}} Velyric workspace',
      body: [
        '{{inviter_name}} invited you to {{workspace_name}} with the {{role_label}} role.',
        'The invitation is valid until {{expires_at}}. If you did not expect this email, you can ignore it.',
      ],
      action: { label: 'Accept invitation', urlKey: 'accept_url' },
    },
  },
  SECURITY_MEMBER_ROLE_CHANGED: {
    hu: {
      subject: 'Szerepkör módosítás a(z) {{workspace_name}} fiókban',
      body: [
        '{{member_email}} szerepköre {{role_label}} lett. A módosítást {{actor_name}} végezte.',
        'Ha nem ismered fel ezt a változtatást, azonnal ellenőrizd a tagokat.',
      ],
      action: { label: 'Tagok megtekintése', urlKey: 'action_url' },
    },
    de: {
      subject: 'Rollenänderung im Konto {{workspace_name}}',
      body: [
        'Die Rolle von {{member_email}} ist jetzt {{role_label}}. Geändert von {{actor_name}}.',
        'Wenn Sie diese Änderung nicht erkennen, prüfen Sie sofort die Mitglieder.',
      ],
      action: { label: 'Mitglieder ansehen', urlKey: 'action_url' },
    },
    en: {
      subject: 'Role changed in the {{workspace_name}} workspace',
      body: [
        'The role of {{member_email}} is now {{role_label}}. Changed by {{actor_name}}.',
        'If you do not recognise this change, review the members immediately.',
      ],
      action: { label: 'View members', urlKey: 'action_url' },
    },
  },
  SUPPORT_REQUEST_RECEIVED: {
    hu: {
      subject: 'Megkaptuk a hibajegyedet: {{ticket_reference}}',
      body: [
        'Rögzítettük a(z) „{{ticket_subject}}” megkeresésedet {{ticket_reference}} azonosítóval.',
        'Amint válaszolunk, e-mailben szólunk, és a párbeszéd a vezérlőpultban folytatható.',
      ],
      action: { label: 'Hibajegy megnyitása', urlKey: 'ticket_url' },
    },
    de: {
      subject: 'Ihre Anfrage ist eingegangen: {{ticket_reference}}',
      body: [
        'Wir haben Ihre Anfrage „{{ticket_subject}}” unter {{ticket_reference}} erfasst.',
        'Sobald wir antworten, erhalten Sie eine E-Mail; das Gespräch läuft im Dashboard weiter.',
      ],
      action: { label: 'Anfrage öffnen', urlKey: 'ticket_url' },
    },
    en: {
      subject: 'We received your request: {{ticket_reference}}',
      body: [
        'We logged your request "{{ticket_subject}}" as {{ticket_reference}}.',
        'You will get an email as soon as we reply, and the conversation continues in the dashboard.',
      ],
      action: { label: 'Open request', urlKey: 'ticket_url' },
    },
  },
  SUPPORT_REQUEST_UPDATED: {
    hu: {
      subject: 'Válaszoltunk: {{ticket_reference}}',
      body: [
        'Új válasz érkezett a(z) „{{ticket_subject}}” hibajegyedre.',
        'Nyisd meg a vezérlőpultban, ott tudsz visszaírni.',
      ],
      action: { label: 'Válasz megtekintése', urlKey: 'ticket_url' },
    },
    de: {
      subject: 'Neue Antwort: {{ticket_reference}}',
      body: [
        'Es gibt eine neue Antwort zu Ihrer Anfrage „{{ticket_subject}}”.',
        'Öffnen Sie sie im Dashboard, dort können Sie direkt antworten.',
      ],
      action: { label: 'Antwort ansehen', urlKey: 'ticket_url' },
    },
    en: {
      subject: 'We replied: {{ticket_reference}}',
      body: [
        'There is a new reply on your request "{{ticket_subject}}".',
        'Open it in the dashboard to continue the conversation.',
      ],
      action: { label: 'View reply', urlKey: 'ticket_url' },
    },
  },
  SECURITY_API_KEY_CREATED: {
    hu: {
      subject: 'Új API kulcs a(z) {{workspace_name}} fiókban',
      body: [
        '{{actor_name}} létrehozta a(z) „{{key_name}}” API kulcsot ({{key_prefix}}).',
        'Ha nem ismered fel, azonnal vond vissza a kulcsot.',
      ],
      action: { label: 'API kulcsok', urlKey: 'action_url' },
    },
    de: {
      subject: 'Neuer API-Schlüssel im Konto {{workspace_name}}',
      body: [
        '{{actor_name}} hat den API-Schlüssel „{{key_name}}“ ({{key_prefix}}) erstellt.',
        'Wenn Sie ihn nicht erkennen, widerrufen Sie ihn sofort.',
      ],
      action: { label: 'API-Schlüssel', urlKey: 'action_url' },
    },
    en: {
      subject: 'New API key in the {{workspace_name}} workspace',
      body: [
        '{{actor_name}} created the API key "{{key_name}}" ({{key_prefix}}).',
        'If you do not recognise it, revoke the key immediately.',
      ],
      action: { label: 'API keys', urlKey: 'action_url' },
    },
  },
};

export interface RenderedNotification {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly templateKey: string;
  readonly templateVersion: string;
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

export function isTemplatedNotification(type: string): type is TemplatedNotificationType {
  return Object.hasOwn(CATALOG, type);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fill(
  template: string,
  payload: Readonly<Record<string, string>>,
  missing: Set<string>,
): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    const value = payload[key];
    if (value === undefined || value === '') {
      missing.add(key);
      return '';
    }
    return value;
  });
}

export function requiredPayloadKeys(type: TemplatedNotificationType): readonly string[] {
  const keys = new Set<string>();
  for (const template of Object.values(CATALOG[type])) {
    for (const line of [template.subject, ...template.body]) {
      for (const match of line.matchAll(PLACEHOLDER)) {
        keys.add(match[1] ?? '');
      }
    }
    if (template.action !== undefined) {
      keys.add(template.action.urlKey);
    }
  }
  return [...keys].sort();
}

export function renderNotification(
  type: TemplatedNotificationType,
  locale: NotificationLocale,
  payload: Readonly<Record<string, string>>,
): RenderedNotification {
  const template = CATALOG[type][locale];
  const missing = new Set<string>();
  const subject = fill(template.subject, payload, missing);
  const paragraphs = template.body.map((line) => fill(line, payload, missing));
  const actionUrl = template.action === undefined ? undefined : payload[template.action.urlKey];
  if (
    template.action !== undefined &&
    (actionUrl === undefined || !/^https?:\/\//.test(actionUrl))
  ) {
    missing.add(template.action.urlKey);
  }
  if (missing.size > 0) {
    throw new RangeError(
      `notification ${type} is missing payload keys: ${[...missing].sort().join(', ')}`,
    );
  }
  const text = [
    ...paragraphs,
    ...(template.action === undefined || actionUrl === undefined
      ? []
      : [`${template.action.label}: ${actionUrl}`]),
    '',
    'Velyric',
  ].join('\n\n');
  const escapedParagraphs = paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(paragraph)}</p>`)
    .join('');
  const button =
    template.action === undefined || actionUrl === undefined
      ? ''
      : `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="background:#6D28D9;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(template.action.label)}</a></p>`;
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#ffffff;font-family:Inter,Arial,sans-serif;color:#111827"><div style="max-width:560px;margin:0 auto;padding:32px 24px"><h1 style="font-size:20px;margin:0 0 20px">${escapeHtml(subject)}</h1>${escapedParagraphs}${button}<p style="margin:32px 0 0;color:#6B7280;font-size:12px">Velyric</p></div></body></html>`;
  return {
    subject,
    text,
    html,
    templateKey: `${type.toLowerCase()}.${locale}`,
    templateVersion: TEMPLATE_VERSION,
  };
}

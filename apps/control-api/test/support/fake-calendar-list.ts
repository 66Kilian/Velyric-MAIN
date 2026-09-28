import type { CalendarListItem, CalendarLister } from '../../src/integrations/calendar-list.js';
import { CalendarListError } from '../../src/integrations/calendar-list.js';
import type { OAuthProvider } from '../../src/integrations/oauth.js';

export class FakeCalendarLister implements CalendarLister {
  respond: (
    provider: OAuthProvider,
    apiBaseUrl: string,
    accessToken: string,
  ) => readonly CalendarListItem[] | CalendarListError = () => [
    { id: 'primary@example.test', name: 'primary@example.test', primary: true },
    { id: 'team@example.test', name: 'Team calendar', primary: false },
  ];

  list(
    provider: OAuthProvider,
    apiBaseUrl: string,
    accessToken: string,
  ): Promise<readonly CalendarListItem[]> {
    const outcome = this.respond(provider, apiBaseUrl, accessToken);
    return outcome instanceof CalendarListError
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  }
}

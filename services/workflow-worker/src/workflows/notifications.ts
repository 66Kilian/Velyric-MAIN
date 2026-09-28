import { proxyActivities } from '@temporalio/workflow';
import {
  NON_RETRYABLE_ERROR,
  type GuestNotificationInput,
  type NotificationActivities,
  type NotifyInput,
  type NotifyResult,
} from './types.js';

const notifications = proxyActivities<NotificationActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '15 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 minutes',
    maximumAttempts: 20,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

export async function notificationWorkflow(input: NotifyInput): Promise<NotifyResult> {
  return notifications.notify(input);
}

const planning = proxyActivities<NotificationActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 10,
    nonRetryableErrorTypes: [NON_RETRYABLE_ERROR],
  },
});

export interface GuestNotificationResult {
  readonly sent: number;
  readonly suppressed: number;
  readonly failed: number;
  readonly offers: number;
}

export async function guestNotificationWorkflow(
  input: GuestNotificationInput,
): Promise<GuestNotificationResult> {
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  const deliver = async (planned: readonly NotifyInput[]): Promise<void> => {
    for (const notification of planned) {
      try {
        const result = await notifications.notify(notification);
        if (result.status === 'SUPPRESSED') {
          suppressed += 1;
        } else {
          sent += 1;
        }
      } catch {
        failed += 1;
      }
    }
  };
  await deliver(await planning.guestNotifications(input));
  const offers =
    input.eventType === 'booking.created' ? [] : await planning.offerReleasedSlot(input);
  await deliver(offers);
  return { sent, suppressed, failed, offers: offers.length };
}

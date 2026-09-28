import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';

export const RETENTION_SCHEDULE_ID = 'retention-sweep-daily';

export async function ensureRetentionSchedule(client: Client): Promise<'CREATED' | 'EXISTS'> {
  try {
    await client.schedule.create({
      scheduleId: RETENTION_SCHEDULE_ID,
      spec: {
        calendars: [{ hour: 2, minute: 30, comment: 'daily retention sweep' }],
        timezone: 'Europe/Budapest',
      },
      action: {
        type: 'startWorkflow',
        workflowType: 'retentionSweepWorkflow',
        taskQueue: 'retention',
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '6 hours' },
    });
    return 'CREATED';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      return 'EXISTS';
    }
    throw error;
  }
}

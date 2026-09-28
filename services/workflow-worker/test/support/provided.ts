export interface ProvidedWorkflowWorkerDatabase {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly template: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    workflowWorkerDb: ProvidedWorkflowWorkerDatabase;
  }
}

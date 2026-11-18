export interface RoutineSetup {
  /** Stable key Paperclip tracks the routine by. Changing it creates a new routine. */
  key: string;
  title: string;
  /** The routine's instructions, given to the agent at each run. */
  description: string;
  /** How often it runs, as shown in Paperclip, e.g. "Every 4 hours". */
  label: string;
  cron: string;
  assigneeAgentId: string;
  /** Whether the usage limit pauses it until someone changes the checkbox. */
  defaultEnabled: boolean;
}

export interface Setup {
  companyId: string;
  projectId: string;
  /** Time zone of the routines' cron expressions. */
  timezone: string;
  routines: RoutineSetup[];
}

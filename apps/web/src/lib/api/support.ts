export interface SupportTicketSummary {
  readonly id: string;
  readonly reference: string;
  readonly subject: string;
  readonly category: string;
  readonly priority: string;
  readonly status: string;
  readonly message_count: number;
  readonly last_message_at: string | null;
  readonly created_at: string;
  readonly unread: number;
}

export interface SupportTicketMessage {
  readonly id: string;
  readonly seq: number;
  readonly author_kind: string;
  readonly author_label: string | null;
  readonly visibility: string;
  readonly body: string;
  readonly created_at: string;
}

export interface SupportTicketEvent {
  readonly kind: string;
  readonly actor_label: string | null;
  readonly created_at: string | null;
}

export interface SupportTicketDetail extends SupportTicketSummary {
  readonly messages: readonly SupportTicketMessage[];
  readonly events: readonly SupportTicketEvent[];
}

export interface AdminTicketSummary {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_name: string;
  readonly reference: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly category: string;
  readonly assigned_staff_user_id: string | null;
  readonly assigned_staff_email: string | null;
  readonly message_count: number;
  readonly last_message_at: string | null;
  readonly last_tenant_message_at: string | null;
  readonly last_staff_message_at: string | null;
  readonly created_at: string | null;
}

export interface AdminTicketDetail extends SupportTicketDetail {
  readonly tenant_id: string;
  readonly workspace_name: string | null;
  readonly workspace_status: string | null;
  readonly workspace_plan: string | null;
  readonly opened_by: string | null;
  readonly assigned_staff_user_id: string | null;
}

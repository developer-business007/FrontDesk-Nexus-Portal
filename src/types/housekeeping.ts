/** Matches Postgres `room_lifecycle_status`. */
export type RoomLifecycleStatus =
  | "occupied"
  | "dirty"
  | "in_service"
  | "clean_ready"
  | "available"
  | "out_of_order";

/** Matches Postgres `hk_task_status`. */
export type HkTaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "inspection_pending"
  | "completed"
  | "cancelled";

export type HkTaskType = "checkout_turnover" | "deep_clean" | "touch_up" | "inspection_only";

export type HkTaskSource =
  | "auto_checkout"
  | "manual"
  | "inspection_fail"
  | "deep_schedule"
  | "pms_sync";

export type HkInspectionResult = "passed" | "failed" | "waived";

export type HousekeepingTask = {
  id: string;
  room_number: string;
  task_type: HkTaskType;
  status: HkTaskStatus;
  source: HkTaskSource;
  priority: number;
  reservation_id: string | null;
  confirmation_number: string | null;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  due_at: string | null;
  requires_inspection: boolean;
  notes: string | null;
  metadata: Record<string, unknown>;
  version: number;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
};

/** Row from `public.v_housekeeping_board`. */
export type HousekeepingBoardRow = {
  room_number: string;
  floor: number;
  wing: string | null;
  zone: string | null;
  room_type: string;
  cleaning_weight: number;
  is_vip: boolean;
  room_status: RoomLifecycleStatus;
  current_task_id: string | null;
  confirmation_number: string | null;
  occupied_confirmation: string | null;
  status_changed_at: string;
  room_status_version: number;
  task_id: string | null;
  task_status: HkTaskStatus | null;
  task_type: HkTaskType | null;
  task_priority: number | null;
  assigned_to: string | null;
  assigned_at: string | null;
  started_at: string | null;
  due_at: string | null;
  requires_inspection: boolean | null;
  maintenance_blocked: boolean;
  maintenance_reason: string | null;
  maintenance_blocked_until: string | null;
};

export type HousekeepingStaff = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
};

export type HousekeepingTaskEvent = {
  id: string;
  task_id: string;
  event_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type RoomOperationalStatus = {
  room_number: string;
  status: RoomLifecycleStatus;
  current_task_id: string | null;
  confirmation_number: string | null;
  occupied_confirmation: string | null;
  status_reason: string | null;
  status_changed_at: string;
  version: number;
};

/** Row from `public.hk_daily_schedules`. */
export type HkDailySchedule = {
  id: string;
  schedule_date: string;
  housekeeper_id: string;
  assigned_rooms: string[];
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from profiles — present when fetched with select("*, housekeeper:profiles(...)") */
  housekeeper?: {
    id: string;
    full_name: string | null;
    email: string | null;
    role: string;
  } | null;
};

export type HkFeedbackType = "complaint" | "compliment" | "note";

/** Row from `public.hk_area_feedback`. */
export type HkAreaFeedback = {
  id: string;
  room_number: string;
  feedback_type: HkFeedbackType;
  description: string | null;
  reported_by: string | null;
  housekeeper_id: string | null;
  task_id: string | null;
  feedback_date: string;
  created_at: string;
};

/** MOP-style FD → HK urgent room alert (`public.hk_alerts`). */
export type HkAlertStatus = "open" | "assigned" | "resolved" | "cancelled";

export type HkAlertPriority = "low" | "medium" | "high" | "urgent";

export type HkAlert = {
  id: string;
  room_number: string;
  duty: string;
  description: string;
  priority: HkAlertPriority;
  status: HkAlertStatus;
  assigned_to: string | null;
  created_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  hotel_date: string;
  created_at: string;
  updated_at: string;
  /** Joined when fetched with profiles */
  assignee?: { id: string; full_name: string | null; email: string | null } | null;
  reporter?: { id: string; full_name: string | null; email: string | null } | null;
};

/** Engineering / repair work order (`public.hk_maintenance_tasks`). */
export type HkMaintenanceStatus = "open" | "in_progress" | "completed" | "cancelled";

export type HkMaintenancePriority = "low" | "medium" | "high" | "urgent";

export type HkMaintenanceTask = {
  id: string;
  room_number: string;
  title: string;
  description: string | null;
  category: string | null;
  status: HkMaintenanceStatus;
  priority: HkMaintenancePriority;
  assigned_to: string | null;
  reported_by: string | null;
  blocks_room: boolean;
  started_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  assignee?: { id: string; full_name: string | null; email: string | null } | null;
  reporter?: { id: string; full_name: string | null; email: string | null } | null;
};

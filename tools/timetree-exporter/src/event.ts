export interface RawEvent {
  uuid: string;
  title: string;
  created_at: number;
  updated_at: number;
  note?: string | null;
  location?: string | null;
  location_lat?: string | null;
  location_lon?: string | null;
  url?: string | null;
  start_at: number;
  start_timezone: string;
  end_at: number;
  end_timezone: string;
  all_day?: boolean;
  alerts?: number[] | null;
  recurrences?: string[] | null;
  parent_id?: string | null;
  recurring_uuid?: string | null;
  type?: number;
  category?: number;
  label_id?: number | null;
  relationships?: { label?: { data?: { id?: string | number } } };
  comments?: string[];
  _image_attachments?: { object_key: string }[];
}

export const EVENT_TYPE = { NORMAL: 0, BIRTHDAY: 1 } as const;
export const EVENT_CATEGORY = { NORMAL: 1, MEMO: 2 } as const;

export interface CalendarLabel {
  name: string;
  color: string | null;
}

export interface TimeTreeEvent {
  uuid: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  note: string | null;
  location: string | null;
  locationLat: string | null;
  locationLon: string | null;
  url: string | null;
  startAt: number;
  startTimezone: string;
  endAt: number;
  endTimezone: string;
  allDay: boolean;
  alerts: number[];
  recurrences: string[];
  parentId: string | null;
  recurringUuid: string | null;
  eventType: number;
  category: number;
  labelId: number | null;
  comments: string[];
}

function extractLabelId(raw: RawEvent): number | null {
  if (raw.label_id != null) return raw.label_id;
  const relId = raw.relationships?.label?.data?.id;
  if (relId != null) {
    if (typeof relId === 'string' && relId.includes(',')) {
      const last = relId.split(',').pop()!;
      const n = Number(last);
      return Number.isNaN(n) ? null : n;
    }
    const n = Number(relId);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Mirrors TimeTreeEvent.from_dict() from the upstream Python exporter. */
export function parseEvent(raw: RawEvent): TimeTreeEvent {
  return {
    uuid: raw.uuid,
    title: raw.title,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    note: raw.note || null,
    location: raw.location || null,
    locationLat: raw.location_lat || null,
    locationLon: raw.location_lon || null,
    url: raw.url || null,
    startAt: raw.start_at,
    startTimezone: raw.start_timezone,
    endAt: raw.end_at,
    endTimezone: raw.end_timezone,
    allDay: !!raw.all_day,
    alerts: raw.alerts ?? [],
    recurrences: raw.recurrences ?? [],
    parentId: raw.parent_id ?? null,
    recurringUuid: raw.recurring_uuid ?? null,
    eventType: raw.type ?? EVENT_TYPE.NORMAL,
    category: raw.category ?? EVENT_CATEGORY.NORMAL,
    labelId: extractLabelId(raw),
    comments: raw.comments ?? [],
  };
}

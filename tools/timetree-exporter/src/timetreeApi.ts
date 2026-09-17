import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_BASE_URI, API_USER_AGENT, ATTACHMENTS_BASE_URI } from './const.js';
import type { CalendarLabel, RawEvent } from './event.js';

export type LabelMap = Map<number, CalendarLabel>;

export interface CalendarUser {
  user_id?: number;
  id?: number;
  name?: string;
}

export interface CalendarMetadata {
  id: number;
  name: string;
  alias_code?: string;
  calendar_users?: CalendarUser[];
}

interface RawActivity {
  author_id?: number;
  comment?: string | { body?: string; text?: string; content?: string; message?: string };
  attachment?: {
    content?: string;
    images?: { object_key?: string }[];
  };
  body?: string;
  text?: string;
  content?: string;
  message?: string;
  [key: string]: unknown;
}

function formatColor(color: unknown): string | null {
  if (typeof color === 'number') return `#${color.toString(16).padStart(6, '0')}`;
  if (typeof color === 'string') return color;
  return null;
}

function extractActivityComment(activity: RawActivity): string | null {
  const comment = activity.comment;
  if (typeof comment === 'string') return comment;
  if (comment && typeof comment === 'object') {
    for (const key of ['body', 'text', 'content', 'message'] as const) {
      const value = comment[key];
      if (value) return value;
    }
  }
  if (activity.attachment?.content) return activity.attachment.content;
  for (const key of ['body', 'text', 'content', 'message'] as const) {
    const value = activity[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Thin client for TimeTree's unofficial, reverse-engineered web-app API.
 * Not affiliated with or supported by TimeTree; endpoints can change or
 * break without notice. See https://github.com/eoleedi/TimeTree-exporter
 * for the community project this was reimplemented from.
 */
export class TimeTreeApi {
  constructor(private readonly sessionId: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Timetreea': API_USER_AGENT,
      Cookie: `_session_id=${this.sessionId}`,
      ...extra,
    };
  }

  async getMetadata(): Promise<CalendarMetadata[]> {
    const res = await fetch(`${API_BASE_URI}/calendars?since=0`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to get calendar metadata (HTTP ${res.status})`);
    const json = (await res.json()) as { calendars: CalendarMetadata[] };
    return json.calendars;
  }

  async getLabels(calendarId: number): Promise<LabelMap> {
    const res = await fetch(`${API_BASE_URI}/calendar/${calendarId}/labels`, {
      headers: this.headers(),
    });
    const labels: LabelMap = new Map();
    if (!res.ok) return labels;
    const json = (await res.json()) as {
      calendar_labels?: { id: number; name?: string; color?: unknown }[];
    };
    for (const label of json.calendar_labels ?? []) {
      labels.set(label.id, { name: label.name ?? '', color: formatColor(label.color) });
    }
    return labels;
  }

  private async fetchEventsSync(calendarId: number, since?: number): Promise<RawEvent[]> {
    const url =
      since === undefined
        ? `${API_BASE_URI}/calendar/${calendarId}/events/sync`
        : `${API_BASE_URI}/calendar/${calendarId}/events/sync?since=${since}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to get events (HTTP ${res.status})`);
    const json = (await res.json()) as { events: RawEvent[]; chunk: boolean; since: number };
    const events = json.events;
    if (json.chunk) {
      events.push(...(await this.fetchEventsSync(calendarId, json.since)));
    }
    return events;
  }

  async getEvents(calendarId: number): Promise<RawEvent[]> {
    return this.fetchEventsSync(calendarId);
  }

  private async fetchEventActivities(
    calendarId: number,
    eventUuid: string,
    since = 0,
  ): Promise<RawActivity[]> {
    const url = `${API_BASE_URI}/calendar/${calendarId}/event/${eventUuid}/activities?since=${since}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      activities?: RawActivity[];
      event_activities?: RawActivity[];
      chunk?: boolean;
      since?: number;
    };
    const activities = json.activities ?? json.event_activities ?? [];
    if (json.chunk && json.since !== undefined) {
      activities.push(...(await this.fetchEventActivities(calendarId, eventUuid, json.since)));
    }
    return activities;
  }

  async getEventComments(
    calendarId: number,
    eventUuid: string,
    userNames: Map<number, string>,
  ): Promise<string[]> {
    const activities = await this.fetchEventActivities(calendarId, eventUuid);
    const comments: string[] = [];
    for (const activity of activities) {
      const comment = extractActivityComment(activity);
      if (comment) {
        const author = activity.author_id != null ? userNames.get(activity.author_id) : undefined;
        comments.push(author ? `${author}: ${comment}` : comment);
      }
    }
    return comments;
  }

  async getEventImages(calendarId: number, eventUuid: string): Promise<{ objectKey: string }[]> {
    const activities = await this.fetchEventActivities(calendarId, eventUuid);
    const images: { objectKey: string }[] = [];
    for (const activity of activities) {
      for (const image of activity.attachment?.images ?? []) {
        if (image.object_key) images.push({ objectKey: image.object_key });
      }
    }
    return images;
  }

  async downloadImage(objectKey: string, outputPath: string): Promise<void> {
    const res = await fetch(`${ATTACHMENTS_BASE_URI}/${objectKey}`, {
      headers: { Cookie: `_session_id=${this.sessionId}` },
    });
    if (!res.ok) throw new Error(`Failed to download image ${objectKey} (HTTP ${res.status})`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(outputPath, buffer);
  }
}
